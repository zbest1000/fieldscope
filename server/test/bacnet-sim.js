// Minimal BACnet/IP device simulator for tests and the sim lab. Answers a
// unicast Who-Is with an I-Am and a ReadProperty of the device object's
// system-status, so the driver's identify and health verdicts can be exercised
// end-to-end. system-status is configurable to drive the non-operational verdict.

import dgram from 'node:dgram';

const SYSTEM_STATUS = {
  operational: 0,
  'operational-read-only': 1,
  'download-required': 2,
  'download-in-progress': 3,
  'non-operational': 4,
  'backup-in-progress': 5,
};

export function startBacnetSim({
  port = 0,
  deviceInstance = 260001,
  vendorId = 36, // Automated Logic
  systemStatus = 'operational',
} = {}) {
  const socket = dgram.createSocket('udp4');

  socket.on('message', (msg, rinfo) => {
    if (msg.length < 6 || msg[0] !== 0x81) return;
    const off = apduOffset(msg);
    if (off < 0) return;
    const apduType = msg[off];

    if (apduType === 0x10 && msg[off + 1] === 0x08) {
      // Who-Is → I-Am
      socket.send(buildIAm(deviceInstance, vendorId), rinfo.port, rinfo.address);
    } else if ((apduType & 0xf0) === 0x00 && msg[off + 3] === 0x0c) {
      // Confirmed ReadProperty. Byte layout: type, maxseg, invoke, svc(12),
      // ctx0 objid (0x0c + 4), ctx1 prop (0x19 + 1).
      const invokeId = msg[off + 2];
      const propId = msg[off + 4 + 5 + 1]; // after ctx0 tag(1)+objid(4) and ctx1 tag(1)
      socket.send(buildReadPropertyAck(invokeId, deviceInstance, propId, systemStatus), rinfo.port, rinfo.address);
    }
  });

  return new Promise((resolve) => {
    socket.bind(port, '127.0.0.1', () => {
      resolve({ socket, port: socket.address().port, close: () => socket.close() });
    });
  });
}

function apduOffset(buf) {
  let off = 4;
  off += 1; // version
  const control = buf[off++];
  if (control & 0x20) {
    off += 2;
    off += buf[off] + 1;
  }
  if (control & 0x08) {
    off += 2;
    off += buf[off] + 1;
  }
  if (control & 0x20) off += 1;
  return off;
}

function frame(func, npduControl, apdu) {
  const npdu = Buffer.from([0x01, npduControl]);
  const body = Buffer.concat([npdu, apdu]);
  const len = body.length + 4;
  return Buffer.concat([Buffer.from([0x81, func, (len >> 8) & 0xff, len & 0xff]), body]);
}

function buildIAm(deviceInstance, vendorId) {
  const objId = (8 << 22) | (deviceInstance & 0x3fffff);
  const obj = Buffer.alloc(5);
  obj.writeUInt8(0xc4, 0); // application tag 12, length 4
  obj.writeUInt32BE(objId >>> 0, 1);
  const maxApdu = Buffer.from([0x22, 0x01, 0x80]); // unsigned, 480
  const seg = Buffer.from([0x91, 0x03]); // enumerated, no-segmentation
  const vendor =
    vendorId > 255 ? Buffer.from([0x22, (vendorId >> 8) & 0xff, vendorId & 0xff]) : Buffer.from([0x21, vendorId & 0xff]);
  const apdu = Buffer.concat([Buffer.from([0x10, 0x00]), obj, maxApdu, seg, vendor]);
  return frame(0x0a, 0x00, apdu);
}

function buildReadPropertyAck(invokeId, deviceInstance, propId, systemStatus) {
  const objId = (8 << 22) | (deviceInstance & 0x3fffff);
  const obj = Buffer.alloc(5);
  obj.writeUInt8(0x0c, 0); // context tag 0, length 4
  obj.writeUInt32BE(objId >>> 0, 1);
  const prop = Buffer.from([0x19, propId & 0xff]); // context tag 1

  let value;
  if (propId === 112) {
    value = Buffer.from([0x91, SYSTEM_STATUS[systemStatus] ?? 0]); // enumerated
  } else if (propId === 121) {
    const s = Buffer.from('Automated Logic', 'utf8');
    value = Buffer.concat([Buffer.from([0x70 | 0x05, s.length + 1, 0x00]), s]); // char string
  } else if (propId === 77) {
    const s = Buffer.from(`Device_${deviceInstance}`, 'utf8');
    value = Buffer.concat([Buffer.from([0x70 | 0x05, s.length + 1, 0x00]), s]);
  } else if (propId === 70) {
    const s = Buffer.from('LGR-1000', 'utf8');
    value = Buffer.concat([Buffer.from([0x70 | 0x05, s.length + 1, 0x00]), s]);
  } else if (propId === 76) {
    // object-list: the device plus a handful of typical objects.
    const ids = [
      (8 << 22) | (deviceInstance & 0x3fffff), // device
      (0 << 22) | 1, // analog-input 1
      (2 << 22) | 1, // analog-value 1
      (3 << 22) | 1, // binary-input 1
      (4 << 22) | 1, // binary-output 1
    ];
    value = Buffer.concat(ids.map((id) => { const b = Buffer.alloc(5); b[0] = 0xc4; b.writeUInt32BE(id >>> 0, 1); return b; }));
  } else {
    value = Buffer.from([0x21, 0x00]);
  }
  const apdu = Buffer.concat([
    Buffer.from([0x30, invokeId, 0x0c]), // complex-ack, invoke, svc 12
    obj,
    prop,
    Buffer.from([0x3e]), // opening tag 3
    value,
    Buffer.from([0x3f]), // closing tag 3
  ]);
  return frame(0x0a, 0x00, apdu);
}
