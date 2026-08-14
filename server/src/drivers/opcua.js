// OPC UA driver (§6.4, §12 phase 5). The flagship IIoT interoperability
// protocol. Full OPC UA is a large binary stack (secure channel, session,
// browse, subscribe); this driver implements the OPC UA Connection Protocol
// (UACP) Hello/Acknowledge handshake — the transport tier that every OPC UA
// session begins with — plus Error-message decode.
//
// That handshake answers real field questions on its own: is there actually an
// OPC UA binary server on opc.tcp (not just an open port), does it accept this
// endpoint URL, and what message/chunk limits does it negotiate? A rejected
// endpoint URL or an unsupported protocol version comes back as a UACP Error
// with a decodable StatusCode — exactly the "why won't my client connect"
// signal. Deeper endpoint/security-policy and cert-chain audit (GetEndpoints
// over a secure channel) is the natural next layer on top of this transport.

import { tcpConnect, tcpRequest } from '../transport/transport.js';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'opcua',
  display_name: 'OPC UA (UACP handshake)',
  domain: 'iiot',
  group: 'iiot',
  transport: ['tcp'],
  default_port: 4840,
  mode: 'full',
  lib: '🟢 raw UACP Hello/Ack',
  describe:
    'OPC UA binary Hello/Acknowledge handshake: endpoint liveness, buffer/chunk negotiation, and decoded UACP protocol errors.',
  verbs: ['connect', 'identify', 'monitor', 'diagnose'],
  params: {
    connect: { endpoint_url: { type: 'string' } },
    identify: { endpoint_url: { type: 'string' } },
  },
};

// A subset of OPC UA StatusCodes relevant to the UACP handshake (Part 6 / Part 4).
const STATUS_TEXT = {
  0x80830000: 'Bad_TcpEndpointUrlInvalid — the server rejected the endpoint URL',
  0x807e0000: 'Bad_TcpMessageTypeInvalid',
  0x807f0000: 'Bad_TcpSecureChannelUnknown',
  0x80800000: 'Bad_TcpMessageTooLarge',
  0x80810000: 'Bad_TcpNotEnoughResources',
  0x80820000: 'Bad_TcpInternalError',
  0x80840000: 'Bad_TcpServerTooBusy',
  0x807d0000: 'Bad_TcpProtocolVersionUnsupported',
};

function statusText(code) {
  return STATUS_TEXT[code >>> 0] || `0x${(code >>> 0).toString(16).padStart(8, '0')}`;
}

// UACP string: int32 length (LE), then UTF-8 bytes. -1 length = null.
function uaString(s) {
  if (s == null) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(-1, 0);
    return b;
  }
  const body = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}

function readUaString(buf, off) {
  const len = buf.readInt32LE(off);
  if (len < 0) return { value: null, next: off + 4 };
  return { value: buf.subarray(off + 4, off + 4 + len).toString('utf8'), next: off + 4 + len };
}

// Build a HEL (Hello) message. MessageType(3)+ChunkType(1)+MessageSize(4) header.
function buildHello(endpointUrl) {
  const body = Buffer.concat([
    u32(0), // ProtocolVersion
    u32(65536), // ReceiveBufferSize
    u32(65536), // SendBufferSize
    u32(0), // MaxMessageSize (0 = no limit)
    u32(0), // MaxChunkCount (0 = no limit)
    uaString(endpointUrl),
  ]);
  const size = 8 + body.length;
  const header = Buffer.concat([Buffer.from('HELF', 'latin1'), u32(size)]);
  return Buffer.concat([header, body]);
}

function messageComplete(buf) {
  if (buf.length < 8) return false;
  return buf.length >= buf.readUInt32LE(4);
}

function parseResponse(buf) {
  if (buf.length < 8) return { error: 'short-frame' };
  const type = buf.toString('latin1', 0, 3);
  const size = buf.readUInt32LE(4);
  if (type === 'ACK') {
    return {
      type,
      ack: {
        protocol_version: buf.readUInt32LE(8),
        receive_buffer: buf.readUInt32LE(12),
        send_buffer: buf.readUInt32LE(16),
        max_message_size: buf.readUInt32LE(20),
        max_chunk_count: buf.readUInt32LE(24),
      },
    };
  }
  if (type === 'ERR') {
    const code = buf.readUInt32LE(8);
    const reason = readUaString(buf, 12).value;
    return { type, error_code: code, error_text: statusText(code), reason };
  }
  return { type, size, note: 'unexpected UACP message type' };
}

async function handshake(ctx) {
  const timeout = ctx.params?.timeout ?? 3000;
  const port = ctx.port || 4840;
  const endpointUrl = ctx.params?.endpoint_url || `opc.tcp://${ctx.host}:${port}`;
  const { socket, connectMs } = await tcpConnect(ctx.host, port, timeout);
  try {
    const hello = buildHello(endpointUrl);
    const { data, rttMs } = await tcpRequest(socket, hello, { timeout, isComplete: messageComplete });
    return { request: hello, response: data, parsed: parseResponse(data), endpointUrl, connectMs, rttMs };
  } finally {
    socket.destroy();
  }
}

function bytesRaw(req, res) {
  return {
    tx: req ? Buffer.from(req).toString('hex') : null,
    rx: res ? Buffer.from(res).toString('hex') : null,
  };
}

function facts(parsed, rttMs) {
  return {
    transport: { tcp_connect: 'success' },
    uacp: {
      ack: parsed.type === 'ACK',
      error: parsed.type === 'ERR' ? parsed.error_text : null,
      type: parsed.type,
    },
    timeout: false,
    rtt_ms: rttMs,
  };
}

function errorFacts(err) {
  const timeout = err.code === 'ETIMEDOUT';
  return {
    transport: { tcp_connect: timeout ? 'success' : 'fail', error: err.code || err.message },
    uacp: { ack: false, type: null },
    timeout,
  };
}

export const verbs = {
  async connect(ctx) {
    try {
      const r = await handshake(ctx);
      const ok = r.parsed.type === 'ACK';
      return {
        artifact: makeArtifact({
          verb: 'connect',
          raw: bytesRaw(r.request, r.response),
          decode: r.parsed,
          result: {
            handshake: ok ? 'acknowledged' : r.parsed.type,
            endpoint_url: r.endpointUrl,
            negotiated: ok ? r.parsed.ack : null,
            error: r.parsed.type === 'ERR' ? `${r.parsed.error_text}${r.parsed.reason ? ` — ${r.parsed.reason}` : ''}` : null,
            rtt_ms: r.rttMs,
          },
        }),
        facts: facts(r.parsed, r.rttMs),
      };
    } catch (err) {
      return {
        artifact: makeArtifact({
          verb: 'connect',
          raw: `error: ${err.code || err.message}`,
          result: { handshake: 'failed', error: err.code || err.message },
          error: err,
        }),
        facts: errorFacts(err),
      };
    }
  },

  // Identify surfaces the negotiated transport limits — the server's declared
  // receive/send buffers and message/chunk caps.
  async identify(ctx) {
    try {
      const r = await handshake(ctx);
      if (r.parsed.type !== 'ACK') {
        return {
          artifact: makeArtifact({
            verb: 'identify',
            raw: bytesRaw(r.request, r.response),
            decode: r.parsed,
            result: { acknowledged: false, response: r.parsed.type, error: r.parsed.error_text || null, reason: r.parsed.reason || null },
          }),
          facts: facts(r.parsed, r.rttMs),
        };
      }
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: bytesRaw(r.request, r.response),
          decode: r.parsed.ack,
          result: {
            acknowledged: true,
            endpoint_url: r.endpointUrl,
            receive_buffer: r.parsed.ack.receive_buffer,
            send_buffer: r.parsed.ack.send_buffer,
            max_message_size: r.parsed.ack.max_message_size || 'unlimited',
            max_chunk_count: r.parsed.ack.max_chunk_count || 'unlimited',
            rtt_ms: r.rttMs,
          },
        }),
        facts: facts(r.parsed, r.rttMs),
      };
    } catch (err) {
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: `error: ${err.code || err.message}`,
          result: { acknowledged: false, error: err.code || err.message },
          error: err,
        }),
        facts: errorFacts(err),
      };
    }
  },

  async monitorSample(ctx) {
    try {
      const r = await handshake(ctx);
      return { value: r.rttMs, ok: r.parsed.type === 'ACK', raw: bytesRaw(r.request, r.response) };
    } catch (err) {
      return { value: null, ok: false, raw: `error: ${err.code || err.message}` };
    }
  },

  async diagnose(ctx) {
    try {
      const r = await handshake(ctx);
      return { facts: facts(r.parsed, r.rttMs), rulepack: 'opcua', raw: bytesRaw(r.request, r.response), decode: r.parsed };
    } catch (err) {
      return { facts: errorFacts(err), rulepack: 'opcua', raw: `error: ${err.code || err.message}` };
    }
  },
};

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

export { buildHello, parseResponse };
