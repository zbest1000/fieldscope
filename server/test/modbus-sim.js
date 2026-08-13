// Minimal Modbus TCP slave simulator for tests. Serves holding/input registers
// and coils, echoes function codes, and can be told to return an exception so
// the driver's exception-code verdicts can be exercised end-to-end.

import net from 'node:net';

export function startModbusSim({ port = 0, exception = null, unitId = 1 } = {}) {
  const holding = new Uint16Array(64);
  const coils = new Uint8Array(64);
  for (let i = 0; i < 64; i++) holding[i] = 1000 + i;

  const server = net.createServer((socket) => {
    socket.on('data', (buf) => {
      if (buf.length < 8) return;
      const tid = buf.readUInt16BE(0);
      const unit = buf.readUInt8(6);
      const fc = buf.readUInt8(7);

      const reply = (pdu) => {
        const header = Buffer.alloc(7);
        header.writeUInt16BE(tid, 0);
        header.writeUInt16BE(0, 2);
        header.writeUInt16BE(pdu.length + 1, 4);
        header.writeUInt8(unit, 6);
        socket.write(Buffer.concat([header, pdu]));
      };

      if (exception) {
        reply(Buffer.from([fc | 0x80, exception]));
        return;
      }

      if (fc === 0x03 || fc === 0x04) {
        const addr = buf.readUInt16BE(8);
        const count = buf.readUInt16BE(10);
        const body = Buffer.alloc(1 + count * 2);
        body.writeUInt8(count * 2, 0);
        for (let i = 0; i < count; i++) body.writeUInt16BE(holding[addr + i] ?? 0, 1 + i * 2);
        reply(Buffer.concat([Buffer.from([fc]), body]));
      } else if (fc === 0x01 || fc === 0x02) {
        const addr = buf.readUInt16BE(8);
        const count = buf.readUInt16BE(10);
        const nbytes = Math.ceil(count / 8);
        const body = Buffer.alloc(1 + nbytes);
        body.writeUInt8(nbytes, 0);
        for (let i = 0; i < count; i++) {
          if (coils[addr + i]) body[1 + Math.floor(i / 8)] |= 1 << i % 8;
        }
        reply(Buffer.concat([Buffer.from([fc]), body]));
      } else if (fc === 0x06) {
        const addr = buf.readUInt16BE(8);
        const val = buf.readUInt16BE(10);
        holding[addr] = val;
        reply(buf.subarray(7)); // echo the PDU
      } else if (fc === 0x05) {
        const addr = buf.readUInt16BE(8);
        const val = buf.readUInt16BE(10);
        coils[addr] = val === 0xff00 ? 1 : 0;
        reply(buf.subarray(7));
      } else {
        reply(Buffer.from([fc | 0x80, 0x01]));
      }
    });
    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, holding, coils });
    });
  });
}
