// Minimal EtherNet/IP device simulator for tests and the sim lab. Answers
// RegisterSession and ListIdentity with a configurable Identity object so the
// driver's status-word and state verdicts can be exercised end-to-end.

import net from 'node:net';

export function startEipSim({
  port = 0,
  productName = 'Fieldscope Sim PLC',
  vendorId = 1,
  deviceType = 0x0e,
  productCode = 0x51,
  status = 0x0005, // owned + configured
  state = 3, // Operational
} = {}) {
  const server = net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 24) {
        const dataLen = pending.readUInt16LE(2);
        if (pending.length < 24 + dataLen) break;
        const frame = pending.subarray(0, 24 + dataLen);
        pending = pending.subarray(24 + dataLen);
        handle(frame, socket);
      }
    });
    socket.on('error', () => {});
  });

  function reply(socket, requestHeader, command, data, sessionHandle = 0, statusCode = 0) {
    const header = Buffer.alloc(24);
    header.writeUInt16LE(command, 0);
    header.writeUInt16LE(data.length, 2);
    header.writeUInt32LE(sessionHandle, 4);
    header.writeUInt32LE(statusCode, 8);
    requestHeader.copy(header, 12, 12, 20); // echo sender context
    socket.write(Buffer.concat([header, data]));
  }

  function identityItem() {
    const name = Buffer.from(productName, 'latin1');
    const body = Buffer.alloc(34 + name.length);
    body.writeUInt16LE(1, 0); // encap protocol version
    body.writeUInt16BE(2, 2); // sin_family AF_INET (big-endian per spec)
    body.writeUInt16BE(44818, 4); // sin_port
    Buffer.from([127, 0, 0, 1]).copy(body, 6); // sin_addr
    body.writeUInt16LE(vendorId, 18);
    body.writeUInt16LE(deviceType, 20);
    body.writeUInt16LE(productCode, 22);
    body.writeUInt16LE(status, 24);
    body.writeUInt8(2, 26); // revision major
    body.writeUInt8(7, 27); // revision minor
    body.writeUInt32LE(0xc0ffee01, 28); // serial
    body.writeUInt8(name.length, 32);
    name.copy(body, 33);
    body.writeUInt8(state, 33 + name.length);

    const item = Buffer.alloc(4);
    item.writeUInt16LE(0x000c, 0); // Identity item type
    item.writeUInt16LE(body.length, 2);
    const count = Buffer.alloc(2);
    count.writeUInt16LE(1, 0);
    return Buffer.concat([count, item, body]);
  }

  function handle(frame, socket) {
    const command = frame.readUInt16LE(0);
    if (command === 0x0065) {
      // RegisterSession: echo version/options, assign a handle.
      reply(socket, frame, command, frame.subarray(24, 28), 0x11223344);
    } else if (command === 0x0063) {
      reply(socket, frame, command, identityItem());
    } else if (command === 0x0066) {
      // UnRegisterSession: no reply per spec.
    } else {
      reply(socket, frame, command, Buffer.alloc(0), 0, 0x0001); // unsupported
    }
  }

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}
