// PROFINET DCP responder simulator for tests and the sim lab. Listens for a DCP
// Identify-All request and replies with one datagram per configured device, so
// the driver's DCP block decode and commissioning verdicts (unconfigured IP,
// duplicate station name) run end-to-end. Carries DCP PDUs over UDP as the test
// transport (real DCP is raw Ethernet 0x8892).

import dgram from 'node:dgram';

const FRAME_ID_IDENTIFY_RES = 0xfeff;
const FRAME_ID_GETSET = 0xfefd;
const LLDP_MARK = 0x88cc;
const PNO_OUI = Buffer.from([0x00, 0x0e, 0xcf]);
const PNO_SUB_PEER = 0x51;

function lldpTlv(type, value) {
  const hdr = Buffer.alloc(2);
  hdr.writeUInt16BE(((type & 0x7f) << 9) | (value.length & 0x1ff), 0);
  return Buffer.concat([hdr, value]);
}

// One LLDP frame: local chassis (station) + port, plus the learned remote peer.
function buildLldpFrame({ station, portId, portDesc, remoteStation, remotePort }) {
  const tlvs = [
    lldpTlv(1, Buffer.concat([Buffer.from([0x07]), Buffer.from(station, 'latin1')])), // Chassis ID (locally assigned)
    lldpTlv(2, Buffer.concat([Buffer.from([0x07]), Buffer.from(portId, 'latin1')])), // Port ID
    lldpTlv(3, Buffer.from([0x00, 0x78])), // TTL 120
    lldpTlv(4, Buffer.from(portDesc, 'latin1')), // Port Description
    lldpTlv(5, Buffer.from(station, 'latin1')), // System Name
  ];
  if (remoteStation) tlvs.push(lldpTlv(127, Buffer.concat([PNO_OUI, Buffer.from([PNO_SUB_PEER]), Buffer.from(`${remoteStation}\x00${remotePort}`, 'latin1')]))); // learned peer
  tlvs.push(lldpTlv(0, Buffer.alloc(0))); // End
  return Buffer.concat([Buffer.from([(LLDP_MARK >> 8) & 0xff, LLDP_MARK & 0xff]), ...tlvs]);
}

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
    // A short PROFINET line: PLC ─(X1 P2)──(X1 P1)─ ET200SP ─(X1 P2)──(X1 P1)─ ET200SP.
    // `ports` carries each port's learned LLDP neighbour (station + remote port).
    {
      name: 'plc-line3', ip: '192.168.0.10', subnet: '255.255.255.0', gateway: '192.168.0.1', vendor: 'Siemens, SIMATIC', vendorId: 0x002a, deviceId: 0x0301, role: 0x02,
      ports: [
        { id: 'port-001', desc: 'X1 P1', remote: null }, // free / available
        { id: 'port-002', desc: 'X1 P2', remote: { station: 'io-station-1', port: 'X1 P1' } },
      ],
    },
    {
      name: 'io-station-1', ip: '192.168.0.20', subnet: '255.255.255.0', gateway: '192.168.0.1', vendor: 'Siemens, ET200SP', vendorId: 0x002a, deviceId: 0x0401, role: 0x01,
      ports: [
        { id: 'port-001', desc: 'X1 P1', remote: { station: 'plc-line3', port: 'X1 P2' } },
        { id: 'port-002', desc: 'X1 P2', remote: { station: 'io-station-2', port: 'X1 P1' } },
      ],
    },
    {
      name: 'io-station-2', ip: '192.168.0.21', subnet: '255.255.255.0', gateway: '192.168.0.1', vendor: 'Siemens, ET200SP', vendorId: 0x002a, deviceId: 0x0401, role: 0x01,
      ports: [
        { id: 'port-001', desc: 'X1 P1', remote: { station: 'io-station-1', port: 'X1 P2' } },
        { id: 'port-002', desc: 'X1 P2', remote: null }, // free / available (end of line)
      ],
    },
  ];
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', (msg, rinfo) => {
    if (msg.length < 4) return;
    const frameId = msg.readUInt16BE(0);
    if (frameId === LLDP_MARK) {
      // LLDP collect → one frame per port (a free port advertises with no peer).
      for (const dev of list) {
        for (const p of dev.ports || []) {
          sock.send(buildLldpFrame({ station: dev.name, portId: p.id, portDesc: p.desc, remoteStation: p.remote?.station, remotePort: p.remote?.port }), rinfo.port, rinfo.address);
        }
      }
      return;
    }
    if (msg.length < 12) return;
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
