// Transport abstraction (§3). Bounded, cancellable primitives the drivers build
// on: TCP connect, TCP request/response, UDP request/response. Raw L2 / pcap /
// serial / radio adapters are declared in the architecture but out of scope for
// this MVP tier (IT + Modbus TCP), which needs only TCP/UDP.

import net from 'node:net';
import dgram from 'node:dgram';
import tls from 'node:tls';

const DEFAULT_TIMEOUT = 3000;

// Open a TCP connection, resolving with { socket, connectMs }. Rejects on
// timeout or refusal. Caller owns closing the socket.
export function tcpConnect(host, port, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const socket = new net.Socket();
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      fn(arg);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => {
      const connectMs = Number(process.hrtime.bigint() - started) / 1e6;
      done(resolve, { socket, connectMs });
    });
    socket.once('timeout', () => {
      socket.destroy();
      done(reject, tagged('ETIMEDOUT', `TCP connect timed out after ${timeout}ms`));
    });
    socket.once('error', (err) => {
      socket.destroy();
      done(reject, err);
    });
    socket.connect(port, host);
  });
}

// Send a request buffer on an already-open socket and collect the response until
// `isComplete(buffer)` is satisfied or the timeout fires. Returns the response
// bytes plus round-trip time.
export function tcpRequest(socket, request, { timeout = DEFAULT_TIMEOUT, isComplete } = {}) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const chunks = [];
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    };
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (!isComplete || isComplete(buf)) {
        const rttMs = Number(process.hrtime.bigint() - started) / 1e6;
        finish(resolve, { data: buf, rttMs });
      }
    };
    const onError = (err) => finish(reject, err);
    const timer = setTimeout(() => {
      const buf = Buffer.concat(chunks);
      if (buf.length) {
        const rttMs = Number(process.hrtime.bigint() - started) / 1e6;
        finish(resolve, { data: buf, rttMs, partial: true });
      } else {
        finish(reject, tagged('ETIMEDOUT', `no response after ${timeout}ms`));
      }
    }, timeout);
    socket.on('data', onData);
    socket.once('error', onError);
    socket.write(request);
  });
}

// One-shot UDP request/response.
export function udpRequest(host, port, request, { timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const socket = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, tagged('ETIMEDOUT', `no UDP response after ${timeout}ms`)),
      timeout,
    );
    socket.once('message', (msg) => {
      const rttMs = Number(process.hrtime.bigint() - started) / 1e6;
      finish(resolve, { data: msg, rttMs });
    });
    socket.once('error', (err) => finish(reject, err));
    socket.send(request, port, host, (err) => {
      if (err) finish(reject, err);
    });
  });
}

// TLS connect that resolves the peer certificate and negotiated params without
// requiring the cert to validate (a diagnostics tool must inspect bad chains).
export function tlsInspect(host, port, timeout = DEFAULT_TIMEOUT, servername) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const socket = tls.connect(
      { host, port, servername: servername || host, rejectUnauthorized: false, timeout },
      () => {
        const handshakeMs = Number(process.hrtime.bigint() - started) / 1e6;
        const cert = socket.getPeerCertificate(true);
        const cipher = socket.getCipher();
        const protocol = socket.getProtocol();
        const authorized = socket.authorized;
        const authError = socket.authorizationError ? String(socket.authorizationError) : null;
        socket.end();
        resolve({ handshakeMs, cert, cipher, protocol, authorized, authError });
      },
    );
    socket.setTimeout(timeout);
    socket.once('timeout', () => {
      socket.destroy();
      reject(tagged('ETIMEDOUT', `TLS handshake timed out after ${timeout}ms`));
    });
    socket.once('error', (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

function tagged(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
