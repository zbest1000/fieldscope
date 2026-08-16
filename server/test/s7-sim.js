// Minimal S7comm PLC simulator for tests and the sim lab. Answers the COTP
// connection request (rack/slot), the S7 setup-communication PDU negotiation,
// and an SZL 0x0011 module-identification read with a configurable order number
// and firmware — so the driver's connect / identify / diagnose run end-to-end.
//
// It can be told to refuse the COTP connection for a specific rack/slot to
// exercise the wrong-rack/slot verdict.

import net from 'node:net';

function tpkt(payload) {
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from([0x03, 0x00, (len >> 8) & 0xff, len & 0xff]), payload]);
}

export function startS7Sim({
  port = 0,
  orderNumber = '6ES7 315-2EH14-0AB0',
  version = '3.2',
  acceptRack = 0,
  acceptSlot = 2,
  refuseWrongSlot = false,
} = {}) {
  const server = net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const len = (pending[2] << 8) | pending[3];
        if (pending.length < len) break;
        handle(pending.subarray(0, len), socket);
        pending = pending.subarray(len);
      }
    });
    socket.on('error', () => {});
  });

  function handle(frame, socket) {
    const cotpType = frame[5];
    if (cotpType === 0xe0) {
      // COTP Connection Request. The dst TSAP (param 0xC2) carries rack/slot.
      const dstTsapIdx = frame.indexOf(0xc2, 5);
      let slotByte = null;
      if (dstTsapIdx >= 0 && frame.length > dstTsapIdx + 3) slotByte = frame[dstTsapIdx + 3];
      const rack = slotByte != null ? (slotByte >> 5) & 0x07 : 0;
      const slot = slotByte != null ? slotByte & 0x1f : 0;
      if (refuseWrongSlot && (rack !== acceptRack || slot !== acceptSlot)) {
        // Refuse: close the connection, as a real CPU does for a bad TSAP.
        socket.destroy();
        return;
      }
      // Connection Confirm (0xD0), echo refs.
      const cc = Buffer.from([0x11, 0xd0, 0x00, 0x01, 0x00, 0x02, 0x00, 0xc0, 0x01, 0x0a, 0xc1, 0x02, 0x01, 0x00, 0xc2, 0x02, 0x01, 0x02]);
      socket.write(tpkt(cc));
    } else if (cotpType === 0xf0) {
      // COTP DT carrying an S7 PDU.
      const s7 = frame.subarray(7);
      if (s7[0] !== 0x32) return;
      const rosctr = s7[1];
      const ref = s7.readUInt16BE(4);
      if (rosctr === 0x01) {
        // Job: distinguish setup-communication (func 0xf0) from ReadVar (0x04).
        const func = s7[10];
        if (func === 0x04) socket.write(readVarResponse(ref, s7));
        else socket.write(setupAck(ref));
      } else if (rosctr === 0x07) {
        // Read SZL → module identification response.
        socket.write(szlResponse(ref, orderNumber, version));
      }
    }
  }

  // A small DB1 dataset: uint16 100 @0, uint16 200 @2, float 50.24 @4 (big-endian).
  const db1 = Buffer.alloc(64);
  db1.writeUInt16BE(100, 0);
  db1.writeUInt16BE(200, 2);
  db1.writeFloatBE(50.24, 4);

  function readVarResponse(ref, s7) {
    const params = s7.subarray(10);
    const item = params.subarray(2, 14); // 0x12,0x0a,0x10,tsize,len(2),db(2),area,addr(3)
    const count = (item[4] << 8) | item[5];
    const db = (item[6] << 8) | item[7];
    const area = item[8];
    const start = ((item[9] << 16) | (item[10] << 8) | item[11]) >> 3; // bit → byte
    if (area === 0x84 && db === 1 && start + count <= db1.length) {
      return readVarAck(ref, db1.subarray(start, start + count), 0xff);
    }
    return readVarAck(ref, Buffer.alloc(0), 0x0a); // object does not exist
  }

  function readVarAck(ref, data, returnCode) {
    const dataItem = returnCode === 0xff
      ? Buffer.concat([Buffer.from([0xff, 0x04, (data.length * 8) >> 8, (data.length * 8) & 0xff]), data]) // len in bits
      : Buffer.from([returnCode, 0x00, 0x00, 0x00]);
    const params = Buffer.from([0x04, 0x01]); // ReadVar, item count 1
    const header = Buffer.alloc(12);
    header[0] = 0x32;
    header[1] = 0x03; // ack_data
    header.writeUInt16BE(0, 2);
    header.writeUInt16BE(ref, 4);
    header.writeUInt16BE(params.length, 6);
    header.writeUInt16BE(dataItem.length, 8);
    header[10] = 0x00;
    header[11] = 0x00;
    return tpkt(Buffer.concat([Buffer.from([0x02, 0xf0, 0x80]), header, params, dataItem]));
  }

  function setupAck(ref) {
    const header = Buffer.alloc(12);
    header[0] = 0x32;
    header[1] = 0x03; // ack_data
    header.writeUInt16BE(0, 2);
    header.writeUInt16BE(ref, 4);
    header.writeUInt16BE(8, 6); // param length
    header.writeUInt16BE(0, 8); // data length
    header[10] = 0x00; // error class
    header[11] = 0x00; // error code
    const params = Buffer.from([0xf0, 0x00, 0x00, 0x01, 0x00, 0x01, 0x01, 0xe0]); // PDU 480
    return tpkt(Buffer.concat([Buffer.from([0x02, 0xf0, 0x80]), header, params]));
  }

  function szlResponse(ref, order, ver) {
    const mlfb = Buffer.alloc(20, 0x20);
    Buffer.from(order, 'latin1').copy(mlfb, 0, 0, Math.min(20, order.length));
    const [v1, v2] = ver.split('.').map((n) => parseInt(n, 10) & 0xff);
    // One 28-byte record: index(2) + MlfB(20) + BGTyp(2) + version(2) + pad(2).
    const record = Buffer.concat([
      Buffer.from([0x00, 0x01]), // record index
      mlfb,
      Buffer.from([0x00, 0x00]), // BGTyp
      Buffer.from([v1, v2]), // Ausbg (firmware version)
      Buffer.from([0x00, 0x00]),
    ]);
    const data = Buffer.concat([
      Buffer.from([0xff, 0x09]), // return code ok, transport octet string
      u16(4 + 8 + record.length), // data length
      Buffer.from([0x00, 0x11, 0x00, 0x01]), // SZL-ID, index
      u16(record.length), // record length
      u16(1), // record count
      record,
    ]);
    const params = Buffer.from([0x00, 0x01, 0x12, 0x08, 0x12, 0x84, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00]);
    const header = Buffer.alloc(10);
    header[0] = 0x32;
    header[1] = 0x07;
    header.writeUInt16BE(0, 2);
    header.writeUInt16BE(ref, 4);
    header.writeUInt16BE(params.length, 6);
    header.writeUInt16BE(data.length, 8);
    return tpkt(Buffer.concat([Buffer.from([0x02, 0xf0, 0x80]), header, params, data]));
  }

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function u16(n) {
  return Buffer.from([(n >> 8) & 0xff, n & 0xff]);
}
