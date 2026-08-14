// Minimal OPC UA server simulator for tests and the sim lab. Speaks the UACP
// Hello/Acknowledge handshake and can be told to reject the endpoint URL with a
// UACP Error, so the driver's ack and protocol-error verdicts run end-to-end.

import net from 'node:net';

export function startOpcuaSim({ port = 0, rejectEndpoint = false, errorCode = 0x80830000 } = {}) {
  const server = net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8) {
        const size = pending.readUInt32LE(4);
        if (pending.length < size) break;
        handle(pending.subarray(0, size), socket);
        pending = pending.subarray(size);
      }
    });
    socket.on('error', () => {});
  });

  function handle(frame, socket) {
    const type = frame.toString('latin1', 0, 3);
    if (type !== 'HEL') return;
    if (rejectEndpoint) {
      socket.write(buildError(errorCode, 'The server does not recognize the endpoint URL.'));
    } else {
      socket.write(buildAck());
    }
  }

  function buildAck() {
    const body = Buffer.alloc(20);
    body.writeUInt32LE(0, 0); // ProtocolVersion
    body.writeUInt32LE(65536, 4); // ReceiveBufferSize
    body.writeUInt32LE(65536, 8); // SendBufferSize
    body.writeUInt32LE(4 * 1024 * 1024, 12); // MaxMessageSize
    body.writeUInt32LE(64, 16); // MaxChunkCount
    const size = 8 + body.length;
    return Buffer.concat([Buffer.from('ACKF', 'latin1'), u32(size), body]);
  }

  function buildError(code, reason) {
    const reasonBuf = Buffer.from(reason, 'utf8');
    const body = Buffer.alloc(8 + reasonBuf.length);
    body.writeUInt32LE(code >>> 0, 0); // Error (StatusCode)
    body.writeInt32LE(reasonBuf.length, 4); // Reason string length
    reasonBuf.copy(body, 8);
    const size = 8 + body.length;
    return Buffer.concat([Buffer.from('ERRF', 'latin1'), u32(size), body]);
  }

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}
