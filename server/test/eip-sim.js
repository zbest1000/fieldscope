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

  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; };

  // Answer a CIP Get_Attribute_Single on the Identity object (class 1).
  function handleCip(cip) {
    const svc = cip[0];
    const pathSize = cip[1];
    const path = cip.subarray(2, 2 + pathSize * 2);
    let cls = null; let attr = null; let p = 0;
    while (p + 2 <= path.length) {
      const seg = path[p];
      if (seg === 0x20) cls = path[p + 1];
      else if (seg === 0x24) { /* instance */ }
      else if (seg === 0x30) attr = path[p + 1];
      else break;
      p += 2;
    }
    const resp = (status, data = Buffer.alloc(0)) => Buffer.concat([Buffer.from([svc | 0x80, 0x00, status, 0x00]), data]);
    if (svc !== 0x0e) return resp(0x08); // only Get_Attribute_Single
    if (cls !== 0x01) return resp(0x05); // path destination unknown
    switch (attr) {
      case 1: return resp(0x00, u16(vendorId));
      case 2: return resp(0x00, u16(deviceType));
      case 3: return resp(0x00, u16(productCode));
      case 4: return resp(0x00, Buffer.from([2, 7])); // revision major.minor
      case 5: return resp(0x00, u16(status));
      case 6: { const b = Buffer.alloc(4); b.writeUInt32LE(0xc0ffee01, 0); return resp(0x00, b); }
      case 7: { const n = Buffer.from(productName, 'latin1'); return resp(0x00, Buffer.concat([Buffer.from([n.length]), n])); }
      default: return resp(0x14); // attribute not supported
    }
  }

  function handle(frame, socket) {
    const command = frame.readUInt16LE(0);
    if (command === 0x0065) {
      // RegisterSession: echo version/options, assign a handle.
      reply(socket, frame, command, frame.subarray(24, 28), 0x11223344);
    } else if (command === 0x0063) {
      reply(socket, frame, command, identityItem());
    } else if (command === 0x006f) {
      // SendRRData: unwrap the CPF unconnected-data item → CIP request → reply.
      const sessionHandle = frame.readUInt32LE(4);
      const data = frame.subarray(24, 24 + frame.readUInt16LE(2));
      let o = 6; // skip interface handle(4) + timeout(2)
      const itemCount = data.readUInt16LE(o); o += 2;
      let cipReq = null;
      for (let i = 0; i < itemCount; i++) {
        const type = data.readUInt16LE(o);
        const len = data.readUInt16LE(o + 2);
        const body = data.subarray(o + 4, o + 4 + len);
        o += 4 + len;
        if (type === 0x00b2) cipReq = body;
      }
      const cipResp = cipReq ? handleCip(cipReq) : Buffer.from([0x80, 0x00, 0x08, 0x00]);
      const cpf = Buffer.concat([u16(2), Buffer.from([0, 0, 0, 0]), u16(0x00b2), u16(cipResp.length), cipResp]);
      reply(socket, frame, command, Buffer.concat([Buffer.alloc(6), cpf]), sessionHandle);
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
