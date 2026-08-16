// PROFINET DCP responder simulator for tests and the sim lab. Listens for a DCP
// Identify-All request and replies with one datagram per configured device, so
// the driver's DCP block decode and commissioning verdicts (unconfigured IP,
// duplicate station name) run end-to-end. Carries DCP PDUs over UDP as the test
// transport (real DCP is raw Ethernet 0x8892).

import dgram from 'node:dgram';

const FRAME_ID_IDENTIFY_RES = 0xfeff;
const FRAME_ID_GETSET = 0xfefd;

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

// Parse a DCP Set request: the harness-select block (option 0xfe) names the
// target device (a UDP stand-in for L2 MAC addressing); the standard 0x02/0x02
// and 0x01/0x02 blocks carry the new station name and IP parameters.
function parseSetRequest(msg) {
  const dataLen = msg.readUInt16BE(10);
  let o = 12;
  const end = Math.min(msg.length, 12 + dataLen);
  const out = { target: null, setName: null, setIp: null, setOption: null, setSub: null };
  while (o + 4 <= end) {
    const option = msg[o];
    const suboption = msg[o + 1];
    const len = msg.readUInt16BE(o + 2);
    const body = msg.subarray(o + 4, o + 4 + len);
    o += 4 + len;
    if (len % 2 === 1) o += 1;
    if (option === 0xfe && suboption === 0x01) {
      out.target = body.toString('latin1'); // no qualifier on the selector
    } else if (option === 0x02 && suboption === 0x02) {
      out.setName = body.subarray(2).toString('latin1'); // skip 2-byte qualifier
      out.setOption = 0x02; out.setSub = 0x02;
    } else if (option === 0x01 && suboption === 0x02) {
      const b = body.subarray(2); // skip qualifier
      out.setIp = { ip: [...b.subarray(0, 4)].join('.'), subnet: [...b.subarray(4, 8)].join('.'), gateway: [...b.subarray(8, 12)].join('.') };
      out.setOption = 0x01; out.setSub = 0x02;
    }
  }
  return out;
}

function buildSetResponse(xid, setOption, setSub, blockError) {
  const ctrl = Buffer.from([setOption, setSub, blockError]); // Option, Suboption, BlockError
  const head = Buffer.alloc(4);
  head[0] = 0x05; // Control
  head[1] = 0x04; // Response
  head.writeUInt16BE(ctrl.length, 2);
  let block = Buffer.concat([head, ctrl]);
  if (ctrl.length % 2 === 1) block = Buffer.concat([block, Buffer.from([0x00])]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(FRAME_ID_GETSET, 0);
  header.writeUInt8(0x04, 2); // Set
  header.writeUInt8(0x01, 3); // response success
  header.writeUInt32BE(xid, 4);
  header.writeUInt16BE(block.length, 10);
  return Buffer.concat([header, block]);
}

export function startProfinetDcpSim({ port = 0, devices = null } = {}) {
  const list = devices || [
    { name: 'plc-line3', ip: '192.168.0.10', subnet: '255.255.255.0', gateway: '192.168.0.1', vendor: 'Siemens, SIMATIC', vendorId: 0x002a, deviceId: 0x0301, role: 0x02 },
    { name: 'io-station-1', ip: '192.168.0.20', subnet: '255.255.255.0', gateway: '192.168.0.1', vendor: 'Siemens, ET200SP', vendorId: 0x002a, deviceId: 0x0401, role: 0x01 },
  ];
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', (msg, rinfo) => {
    if (msg.length < 12) return;
    const frameId = msg.readUInt16BE(0);
    const xid = msg.readUInt32BE(4);
    if (frameId === 0xfefe) {
      // Identify-All → one datagram per device.
      for (const dev of list) sock.send(buildResponse(xid, dev), rinfo.port, rinfo.address);
      return;
    }
    if (frameId === FRAME_ID_GETSET && msg.readUInt8(2) === 0x04) {
      // DCP Set → apply to the addressed device, then acknowledge.
      const { target, setName, setIp, setOption, setSub } = parseSetRequest(msg);
      const dev = target ? list.find((d) => d.name === target) : list[0];
      let blockError = 0x00;
      if (!dev) blockError = 0x04; // resource error: no such device
      else {
        if (setName != null) dev.name = setName;
        if (setIp) { dev.ip = setIp.ip; dev.subnet = setIp.subnet; dev.gateway = setIp.gateway; }
      }
      sock.send(buildSetResponse(xid, setOption ?? 0x02, setSub ?? 0x02, blockError), rinfo.port, rinfo.address);
    }
  });

  return new Promise((resolve) => {
    sock.bind(port, '127.0.0.1', () => resolve({ sock, port: sock.address().port, close: () => sock.close() }));
  });
}
