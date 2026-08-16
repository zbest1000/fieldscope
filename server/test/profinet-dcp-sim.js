// PROFINET DCP responder simulator for tests and the sim lab. Listens for a DCP
// Identify-All request and replies with one datagram per configured device, so
// the driver's DCP block decode and commissioning verdicts (unconfigured IP,
// duplicate station name) run end-to-end. Carries DCP PDUs over UDP as the test
// transport (real DCP is raw Ethernet 0x8892).

import dgram from 'node:dgram';

const FRAME_ID_IDENTIFY_RES = 0xfeff;

function block(option, suboption, payload) {
  // Response block: option, suboption, len(2), BlockInfo(2), payload; padded even.
  const body = Buffer.concat([Buffer.from([0x00, 0x00]), payload]); // BlockInfo = 0
  const head = Buffer.alloc(4);
  head[0] = option;
  head[1] = suboption;
  head.writeUInt16BE(body.length, 2);
  let b = Buffer.concat([head, body]);
  if (body.length % 2 === 1) b = Buffer.concat([b, Buffer.from([0x00])]); // pad
  return b;
}

function ipBytes(s) {
  return Buffer.from(s.split('.').map(Number));
}

function buildResponse(xid, dev) {
  const blocks = Buffer.concat([
    block(0x02, 0x01, Buffer.from(dev.vendor || 'Fieldscope PN', 'latin1')), // DeviceVendorValue
    block(0x02, 0x02, Buffer.from(dev.name || 'device', 'latin1')), // NameOfStation
    (() => { const b = Buffer.alloc(4); b.writeUInt16BE(dev.vendorId ?? 0x002a, 0); b.writeUInt16BE(dev.deviceId ?? 0x0101, 2); return block(0x02, 0x03, b); })(),
    block(0x02, 0x04, Buffer.from([dev.role ?? 0x01, 0x00])), // DeviceRole
    block(0x01, 0x02, Buffer.concat([ipBytes(dev.ip || '0.0.0.0'), ipBytes(dev.subnet || '0.0.0.0'), ipBytes(dev.gateway || '0.0.0.0')])), // IPParameter
  ]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(FRAME_ID_IDENTIFY_RES, 0);
  header.writeUInt8(0x05, 2); // Identify
  header.writeUInt8(0x01, 3); // response success
  header.writeUInt32BE(xid, 4);
  header.writeUInt16BE(blocks.length, 10);
  return Buffer.concat([header, blocks]);
}

export function startProfinetDcpSim({ port = 0, devices = null } = {}) {
  const list = devices || [
    { name: 'plc-line3', ip: '192.168.0.10', subnet: '255.255.255.0', gateway: '192.168.0.1', vendor: 'Siemens, SIMATIC', vendorId: 0x002a, deviceId: 0x0301, role: 0x02 },
    { name: 'io-station-1', ip: '192.168.0.20', subnet: '255.255.255.0', gateway: '192.168.0.1', vendor: 'Siemens, ET200SP', vendorId: 0x002a, deviceId: 0x0401, role: 0x01 },
  ];
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', (msg, rinfo) => {
    if (msg.length < 10 || msg.readUInt16BE(0) !== 0xfefe) return; // Identify request
    const xid = msg.readUInt32BE(4);
    for (const dev of list) sock.send(buildResponse(xid, dev), rinfo.port, rinfo.address);
  });

  return new Promise((resolve) => {
    sock.bind(port, '127.0.0.1', () => resolve({ sock, port: sock.address().port, close: () => sock.close() }));
  });
}
