// PROFINET DCP + LLDP driver (§6.2) — "who is on this segment and how is it
// wired". DCP (Discovery and Configuration Protocol) finds PROFINET devices and
// reads their station name / IP / vendor / role, and assigns names and
// addresses; LLDP (IEEE 802.1AB) supplies the per-port neighbour table that
// reconstructs the physical port-to-port topology. Its flagship diagnostic is
// the commissioning pain: a brand-new device that has a name but no IP
// (0.0.0.0), or two devices sharing one station name.
//
// Honest transport note (§10, §11): real DCP and LLDP ride *raw Ethernet* —
// Layer-2 multicasts, EtherTypes 0x8892 (DCP) and 0x88cc (LLDP) — so they need a
// raw/mirror adapter and admin rights (declared requires_l2 / requires_admin).
// This build implements the DCP and LLDP PDU codecs and exercises them over a
// UDP test responder (the sim lab, or an L2-over-UDP gateway). On a live plant
// network the same codecs are driven over the L2 socket.

import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'profinet-dcp',
  display_name: 'PROFINET DCP / LLDP',
  domain: 'industrial',
  group: 'industrial',
  transport: ['l2'],
  default_port: null,
  requires_l2: true,
  requires_admin: true,
  write_capable: true,
  mode: 'full',
  lib: '🟡 raw Ethernet (DCP 0x8892 / LLDP 0x88cc)',
  describe: 'DCP Identify-All discovery, an LLDP physical port topology, and DCP Set to commission station name / IP / subnet / gateway (ARM-gated). Needs a raw/mirror Ethernet adapter on real networks.',
  verbs: ['identify', 'browse', 'write', 'diagnose'],
  params: {
    identify: {
      responder: { type: 'string', default: '127.0.0.1' },
      responder_port: { type: 'number', default: 34964, min: 1, max: 65535 },
      window_ms: { type: 'number', default: 2000, min: 500, max: 8000 },
    },
    // Browse renders the segment as a topology graph (who is wired to whom).
    browse: {
      responder: { type: 'string', default: '127.0.0.1' },
      responder_port: { type: 'number', default: 34964, min: 1, max: 65535 },
      window_ms: { type: 'number', default: 2000, min: 500, max: 8000 },
    },
    // DCP Set — the commissioning write. `target` selects the device by its
    // current station name; set-name renames it, set-ip assigns the IP / subnet
    // / gateway. Gated behind ARM + per-write confirm (§4.1).
    write: {
      operation: { type: 'enum', options: ['set-name', 'set-ip'], default: 'set-ip' },
      target: { type: 'string', default: '' },
      new_name: { type: 'string', default: '' },
      ip: { type: 'string', default: '192.168.0.20' },
      subnet: { type: 'string', default: '255.255.255.0' },
      gateway: { type: 'string', default: '192.168.0.1' },
      responder: { type: 'string', default: '127.0.0.1' },
      responder_port: { type: 'number', default: 34964, min: 1, max: 65535 },
      window_ms: { type: 'number', default: 2000, min: 500, max: 8000 },
    },
    diagnose: {
      responder: { type: 'string', default: '127.0.0.1' },
      responder_port: { type: 'number', default: 34964, min: 1, max: 65535 },
      window_ms: { type: 'number', default: 2000, min: 500, max: 8000 },
    },
  },
};

const FRAME_ID_IDENTIFY_REQ = 0xfefe;
const FRAME_ID_IDENTIFY_RES = 0xfeff;
const FRAME_ID_GETSET = 0xfefd; // DCP Get/Set uses one FrameID for request + response
const SERVICE_SET = 0x04;
const SERVICE_TYPE_REQUEST = 0x00;
const SERVICE_TYPE_RESPONSE = 0x01;
// DCP option/suboption pairs (IEC 61158-6-10).
const OPT_IP = 0x01;
const SUB_IP_PARAM = 0x02; // IP + subnet + gateway
const OPT_DEVICE = 0x02;
const SUB_NAME = 0x02; // NameOfStation
const OPT_CONTROL = 0x05;
const SUB_RESPONSE = 0x04; // Set response (carries the BlockError)
// Harness-only addressing shim: real DCP Set is unicast to the device's MAC, so
// the wire never needs to name its target. Over the UDP test transport a single
// socket fronts every simulated device, so we prepend this non-standard selector
// (option 0xfe) carrying the target's current station name. It is stripped by
// the sim and never emitted on a real L2 socket (which addresses by MAC).
const OPT_HARNESS_SELECT = 0xfe;
const SUB_SELECT_NAME = 0x01;
const BLOCK_QUALIFIER_SET_PERMANENT = 0x0001; // store persistently
const ROLE = { 0x00: 'none', 0x01: 'IO-Device', 0x02: 'IO-Controller', 0x04: 'IO-Multidevice', 0x08: 'PN-Supervisor' };
const BLOCK_ERROR = { 0x00: 'ok', 0x01: 'option not supported', 0x02: 'suboption not supported', 0x03: 'suboption not set', 0x04: 'resource error', 0x05: 'set not possible', 0x06: 'in operation' };

const ipBytes = (s) => Buffer.from(String(s || '0.0.0.0').split('.').map((n) => Number(n) & 0xff));

// One DCP block: option, suboption, length(2), [qualifier(2)], payload; padded even.
function dcpBlock(option, suboption, payload, qualifier = null) {
  const q = qualifier == null ? Buffer.alloc(0) : (() => { const b = Buffer.alloc(2); b.writeUInt16BE(qualifier, 0); return b; })();
  const body = Buffer.concat([q, payload]);
  const head = Buffer.alloc(4);
  head[0] = option;
  head[1] = suboption;
  head.writeUInt16BE(body.length, 2);
  let b = Buffer.concat([head, body]);
  if (body.length % 2 === 1) b = Buffer.concat([b, Buffer.from([0x00])]);
  return b;
}

// Build a DCP Set request PDU. Returns { buf, xid }.
export function buildSet({ operation, target, name, ip, subnet, gateway }) {
  const xid = crypto.randomBytes(4).readUInt32BE(0);
  const blocks = [];
  if (target) blocks.push(dcpBlock(OPT_HARNESS_SELECT, SUB_SELECT_NAME, Buffer.from(target, 'latin1'))); // no qualifier
  if (operation === 'set-name') {
    blocks.push(dcpBlock(OPT_DEVICE, SUB_NAME, Buffer.from(name || '', 'latin1'), BLOCK_QUALIFIER_SET_PERMANENT));
  } else {
    const body = Buffer.concat([ipBytes(ip), ipBytes(subnet), ipBytes(gateway)]);
    blocks.push(dcpBlock(OPT_IP, SUB_IP_PARAM, body, BLOCK_QUALIFIER_SET_PERMANENT));
  }
  const data = Buffer.concat(blocks);
  const header = Buffer.alloc(10);
  header.writeUInt16BE(FRAME_ID_GETSET, 0);
  header.writeUInt8(SERVICE_SET, 2);
  header.writeUInt8(SERVICE_TYPE_REQUEST, 3);
  header.writeUInt32BE(xid, 4);
  header.writeUInt16BE(0x0000, 8); // ResponseDelay
  const dataLen = Buffer.alloc(2);
  dataLen.writeUInt16BE(data.length, 0);
  return { buf: Buffer.concat([header, dataLen, data]), xid };
}

// Decode a DCP Set response PDU → { xid, ok, block_error, block_error_text }.
export function parseSetResponse(buf) {
  if (buf.length < 12 || buf.readUInt16BE(0) !== FRAME_ID_GETSET) return null;
  const out = { xid: buf.readUInt32BE(4), service_type: buf.readUInt8(3), block_error: null };
  const dataLen = buf.readUInt16BE(10);
  let o = 12;
  const end = Math.min(buf.length, 12 + dataLen);
  while (o + 4 <= end) {
    const option = buf[o];
    const suboption = buf[o + 1];
    const len = buf.readUInt16BE(o + 2);
    const body = buf.subarray(o + 4, o + 4 + len);
    o += 4 + len;
    if (len % 2 === 1) o += 1;
    if (option === OPT_CONTROL && suboption === SUB_RESPONSE && body.length >= 3) {
      out.set_option = body[0];
      out.set_suboption = body[1];
      out.block_error = body[2];
    }
  }
  out.block_error_text = BLOCK_ERROR[out.block_error] || `error 0x${(out.block_error ?? 0).toString(16)}`;
  out.ok = out.service_type === SERVICE_TYPE_RESPONSE && (out.block_error === 0 || out.block_error == null);
  return out;
}

// Send a DCP Set request and wait for the matching response in the window.
function sendSet(ctx, buf, xid) {
  const responder = ctx.params?.responder || '127.0.0.1';
  const port = ctx.params?.responder_port ?? 34964;
  const windowMs = Math.min(8000, Math.max(500, ctx.params?.window_ms ?? 2000));
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let settled = false;
    const finish = (parsed, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      resolve({ parsed, response: parsed?._raw || null, error: err || null });
    };
    sock.on('error', (e) => finish(null, e.code || e.message));
    sock.on('message', (msg) => {
      const p = parseSetResponse(msg);
      if (p && p.xid === xid) { p._raw = msg; finish(p, null); }
    });
    const timer = setTimeout(() => finish(null, null), windowMs);
    sock.bind(0, () => sock.send(buf, port, responder, (e) => { if (e) finish(null, e.code || e.message); }));
  });
}

function maskToCidr(mask) {
  return mask.split('.').reduce((c, o) => c + ((Number(o) >>> 0).toString(2).match(/1/g) || []).length, 0);
}
function networkOf(ipStr, maskStr) {
  const a = ipStr.split('.').map(Number);
  const m = maskStr.split('.').map(Number);
  return `${a.map((o, i) => o & m[i]).join('.')}/${maskToCidr(maskStr)}`;
}

// ---- LLDP neighbour discovery (the port-level half of the topology) --------
// The physical topology — a device's ports and which port cables to which
// neighbour port — is reconstructed from LLDP (IEEE 802.1AB, EtherType 0x88cc),
// not DCP. Each PROFINET port multicasts an LLDPDU announcing its own chassis
// (station name) + port; a receiver learns its neighbour from the frame arriving
// on a given local port. A collector either passively captures every LLDPDU on
// the segment or reads each device's lldpRemoteSystemsData MIB, then joins them
// into port-to-port links. Real LLDP is raw L2 (declared requires_l2); over the
// UDP test harness the responder returns the already-resolved remote table,
// encoded as LLDP TLV frames, so one collect call yields the same link set.
const LLDP_MARK = 0x88cc; // harness marker for an LLDP-collect request
const LLDP_TLV = { END: 0, CHASSIS_ID: 1, PORT_ID: 2, TTL: 3, PORT_DESC: 4, SYS_NAME: 5, ORG: 127 };
const PNO_OUI = Buffer.from([0x00, 0x0e, 0xcf]); // PROFINET (PNO) organisationally-unique id
const PNO_SUB_PEER = 0x51; // harness suboption: learned remote peer (station + port)

function lldpTlv(type, value) {
  const hdr = Buffer.alloc(2);
  hdr.writeUInt16BE(((type & 0x7f) << 9) | (value.length & 0x1ff), 0);
  return Buffer.concat([hdr, value]);
}

// Encode one device port's LLDP view (local chassis/port + learned neighbour).
export function buildLldpFrame({ station, portId, portDesc, remoteStation, remotePort }) {
  const tlvs = [
    lldpTlv(LLDP_TLV.CHASSIS_ID, Buffer.concat([Buffer.from([0x07]), Buffer.from(station, 'latin1')])), // subtype 7 = locally assigned
    lldpTlv(LLDP_TLV.PORT_ID, Buffer.concat([Buffer.from([0x07]), Buffer.from(portId, 'latin1')])),
    lldpTlv(LLDP_TLV.TTL, Buffer.from([0x00, 0x78])), // 120 s
    lldpTlv(LLDP_TLV.PORT_DESC, Buffer.from(portDesc, 'latin1')),
    lldpTlv(LLDP_TLV.SYS_NAME, Buffer.from(station, 'latin1')),
  ];
  if (remoteStation) {
    const peer = Buffer.concat([PNO_OUI, Buffer.from([PNO_SUB_PEER]), Buffer.from(`${remoteStation}\x00${remotePort || ''}`, 'latin1')]);
    tlvs.push(lldpTlv(LLDP_TLV.ORG, peer));
  }
  tlvs.push(lldpTlv(LLDP_TLV.END, Buffer.alloc(0)));
  return Buffer.concat([Buffer.from([(LLDP_MARK >> 8) & 0xff, LLDP_MARK & 0xff]), ...tlvs]);
}

// Decode an LLDP frame → a remote-table row.
export function parseLldpFrame(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== LLDP_MARK) return null;
  const row = { station: null, port_id: null, port_desc: null, remote_station: null, remote_port: null };
  let o = 2;
  while (o + 2 <= buf.length) {
    const h = buf.readUInt16BE(o);
    const type = (h >> 9) & 0x7f;
    const len = h & 0x1ff;
    const val = buf.subarray(o + 2, o + 2 + len);
    o += 2 + len;
    if (type === LLDP_TLV.END) break;
    if (type === LLDP_TLV.CHASSIS_ID) row.station = val.subarray(1).toString('latin1');
    else if (type === LLDP_TLV.PORT_ID) row.port_id = val.subarray(1).toString('latin1');
    else if (type === LLDP_TLV.PORT_DESC) row.port_desc = val.toString('latin1');
    else if (type === LLDP_TLV.SYS_NAME && !row.station) row.station = val.toString('latin1');
    else if (type === LLDP_TLV.ORG && val.length >= 4 && val.subarray(0, 3).equals(PNO_OUI) && val[3] === PNO_SUB_PEER) {
      const [rs, rp] = val.subarray(4).toString('latin1').split('\x00');
      row.remote_station = rs || null;
      row.remote_port = rp || null;
    }
  }
  return row;
}

// Collect the LLDP remote table from the segment (one datagram per port link).
function collectLldp(ctx) {
  const responder = ctx.params?.responder || '127.0.0.1';
  const port = ctx.params?.responder_port ?? 34964;
  const windowMs = Math.min(8000, Math.max(500, ctx.params?.window_ms ?? 2000));
  const req = Buffer.from([(LLDP_MARK >> 8) & 0xff, LLDP_MARK & 0xff, 0x00, 0x00]); // collect request
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const rows = [];
    const seen = new Set();
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      resolve({ rows, error: err || null });
    };
    sock.on('error', (e) => finish(e.code || e.message));
    sock.on('message', (msg) => {
      const key = msg.toString('hex');
      if (seen.has(key)) return;
      seen.add(key);
      const r = parseLldpFrame(msg);
      // Keep every advertised port (a free port has no remote) so the map can
      // show available ports, not just cabled ones.
      if (r && r.station && (r.port_desc || r.port_id)) rows.push(r);
    });
    const timer = setTimeout(() => finish(null), windowMs);
    sock.bind(0, () => sock.send(req, port, responder, (e) => { if (e) finish(e.code || e.message); }));
  });
}

const kindOf = (role) => ((role || '').includes('Controller') ? 'controller' : (role || '').includes('Supervisor') ? 'supervisor' : 'device');

// Physical topology from LLDP: device boxes carrying their ports, joined by
// port-to-port cables (deduped so A→B and B→A collapse to one link) — you can
// read which local port connects to which neighbour port. DCP identity (IP /
// vendor / role) is merged in per station.
function buildPhysicalTopology(devices, rows) {
  const byName = new Map();
  const ensure = (station) => {
    if (!byName.has(station)) {
      const d = devices.find((x) => x.name_of_station === station);
      byName.set(station, {
        id: `dev:${station}`,
        label: station,
        kind: d ? kindOf(d.role) : 'switch', // an LLDP peer with no DCP identity is a switch/infrastructure port
        ip: d && d.ip && d.ip !== '0.0.0.0' ? d.ip : null,
        vendor: d ? (d.vendor || (d.vendor_id != null ? `vendor ${d.vendor_id}` : null)) : null,
        role: d ? d.role : null,
        ports: [],
      });
    }
    return byName.get(station);
  };
  // Every DCP device shows up even if it has no LLDP neighbour yet.
  for (const d of devices) ensure(d.name_of_station || '(no name)');

  const addPort = (node, portName) => {
    if (!portName) return;
    if (!node.ports.some((p) => p.name === portName)) node.ports.push({ name: portName, linked: false });
  };
  const links = [];
  const linkSeen = new Set();
  for (const r of rows) {
    const localPort = r.port_desc || r.port_id;
    const a = ensure(r.station);
    addPort(a, localPort);
    if (!r.remote_station) continue; // a free port: shown as available, no cable
    const b = ensure(r.remote_station);
    addPort(b, r.remote_port);
    const aP = a.ports.find((p) => p.name === localPort);
    const bP = b.ports.find((p) => p.name === r.remote_port);
    if (aP) aP.linked = true;
    if (bP) bP.linked = true;
    const key = [`${r.station}|${localPort}`, `${r.remote_station}|${r.remote_port}`].sort().join('::');
    if (linkSeen.has(key)) continue;
    linkSeen.add(key);
    links.push({ a: { station: r.station, port: localPort }, b: { station: r.remote_station, port: r.remote_port } });
  }
  // Stable port order per device (X1 P1, X1 P2, …).
  for (const n of byName.values()) n.ports.sort((p, q) => p.name.localeCompare(q.name, undefined, { numeric: true }));
  return {
    kind: 'physical',
    nodes: [...byName.values()],
    links,
    note: 'Physical topology from LLDP (IEEE 802.1AB) — device ports and the port-to-port cabling. Device identity/IP is joined in from DCP. Real LLDP is raw Ethernet 0x88cc (declared requires_l2); collected here over the UDP test harness.',
  };
}

// Fallback when no LLDP is present: the logical DCP view — devices grouped by IP
// subnet, IO-Controller as the hub each IO-Device hangs off.
function buildLogicalTopology(devices) {
  const withId = devices.map((d, i) => ({ ...d, _id: `dev${i}` }));
  const bySubnet = new Map();
  for (const d of withId) {
    const key = d.ip && d.ip !== '0.0.0.0' && d.subnet && d.subnet !== '0.0.0.0' ? networkOf(d.ip, d.subnet) : 'unconfigured';
    if (!bySubnet.has(key)) bySubnet.set(key, []);
    bySubnet.get(key).push(d);
  }
  const nodes = [];
  const edges = [];
  let s = 0;
  for (const [key, devs] of bySubnet) {
    const segId = `seg${s++}`;
    nodes.push({ id: segId, label: key === 'unconfigured' ? 'no IP / unconfigured' : key, kind: 'segment' });
    const hub = devs.find((d) => (d.role || '').includes('Controller'));
    for (const d of devs) {
      nodes.push({
        id: d._id,
        label: d.name_of_station || '(no name)',
        kind: kindOf(d.role),
        ip: d.ip && d.ip !== '0.0.0.0' ? d.ip : null,
        vendor: d.vendor || (d.vendor_id != null ? `vendor ${d.vendor_id}` : null),
        role: d.role,
      });
      if (hub && d._id !== hub._id) edges.push({ from: hub._id, to: d._id });
      else edges.push({ from: segId, to: d._id });
    }
  }
  return {
    kind: 'logical',
    nodes,
    edges,
    note: 'Logical topology from DCP (station name / role / subnet) — no LLDP neighbours were seen, so port-level cabling is unknown. On a live segment the physical port graph is drawn from LLDP.',
  };
}

// Build a DCP Identify-All request PDU. Returns { buf, xid }.
export function buildIdentifyAll() {
  const xid = crypto.randomBytes(4).readUInt32BE(0);
  const block = Buffer.from([0xff, 0xff, 0x00, 0x00]); // AllSelector, block length 0
  const header = Buffer.alloc(10);
  header.writeUInt16BE(FRAME_ID_IDENTIFY_REQ, 0);
  header.writeUInt8(0x05, 2); // ServiceID = Identify
  header.writeUInt8(0x00, 3); // ServiceType = request
  header.writeUInt32BE(xid, 4);
  header.writeUInt16BE(0x00ff, 8); // ResponseDelay (slots)
  const dataLen = Buffer.alloc(2);
  dataLen.writeUInt16BE(block.length, 0);
  return { buf: Buffer.concat([header, dataLen, block]), xid };
}

const ip = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;

// Decode a DCP Identify response PDU into a device record.
export function parseIdentifyResponse(buf) {
  if (buf.length < 12) return null;
  if (buf.readUInt16BE(0) !== FRAME_ID_IDENTIFY_RES) return null;
  const dev = { xid: buf.readUInt32BE(4), name_of_station: null, ip: null, subnet: null, gateway: null, vendor: null, vendor_id: null, device_id: null, role: null };
  const dataLen = buf.readUInt16BE(10);
  let o = 12;
  const end = Math.min(buf.length, 12 + dataLen);
  while (o + 4 <= end) {
    const option = buf[o];
    const suboption = buf[o + 1];
    const blockLen = buf.readUInt16BE(o + 2);
    const body = buf.subarray(o + 4, o + 4 + blockLen);
    o += 4 + blockLen;
    if (blockLen % 2 === 1) o += 1; // pad to even
    // Response blocks carry a 2-byte BlockInfo prefix before the payload.
    const payload = body.subarray(2);
    if (option === 0x02 && suboption === 0x02) dev.name_of_station = payload.toString('latin1');
    else if (option === 0x02 && suboption === 0x01) dev.vendor = payload.toString('latin1');
    else if (option === 0x02 && suboption === 0x03 && payload.length >= 4) {
      dev.vendor_id = payload.readUInt16BE(0);
      dev.device_id = payload.readUInt16BE(2);
    } else if (option === 0x02 && suboption === 0x04 && payload.length >= 1) {
      dev.role = ROLE[payload[0]] || `role ${payload[0]}`;
    } else if (option === 0x01 && suboption === 0x02 && payload.length >= 12) {
      dev.ip = ip(payload, 0);
      dev.subnet = ip(payload, 4);
      dev.gateway = ip(payload, 8);
    }
  }
  return dev;
}

// Send Identify-All and collect every device response in the window.
function identifyAll(ctx) {
  const responder = ctx.params?.responder || '127.0.0.1';
  const port = ctx.params?.responder_port ?? 34964;
  const windowMs = Math.min(8000, Math.max(500, ctx.params?.window_ms ?? 2000));
  const { buf, xid } = buildIdentifyAll();
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const devices = [];
    const seen = new Set(); // byte-identical frames are transport dups, not devices
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      resolve({ devices, xid, request: buf, error: err || null });
    };
    sock.on('error', (e) => finish(e.code || e.message));
    sock.on('message', (msg) => {
      const key = msg.toString('hex');
      if (seen.has(key)) return;
      seen.add(key);
      const d = parseIdentifyResponse(msg);
      if (d && d.xid === xid) devices.push(d);
    });
    const timer = setTimeout(() => finish(null), windowMs);
    sock.bind(0, () => sock.send(buf, port, responder, (e) => { if (e) finish(e.code || e.message); }));
  });
}

function analyze(devices) {
  const names = devices.map((d) => d.name_of_station).filter(Boolean);
  const dupNames = names.filter((n, i) => names.indexOf(n) !== i);
  const unconfigured = devices.filter((d) => !d.ip || d.ip === '0.0.0.0');
  return {
    count: devices.length,
    duplicate_names: [...new Set(dupNames)],
    unconfigured: unconfigured.map((d) => d.name_of_station || '(no name)'),
  };
}

export const verbs = {
  async identify(ctx) {
    const res = await identifyAll(ctx);
    const a = analyze(res.devices);
    return {
      artifact: makeArtifact({
        verb: 'identify',
        raw: `DCP Identify-All xid=0x${res.xid.toString(16)} → ${res.devices.length} device(s)${res.error ? ` · ${res.error}` : ''}`,
        decode: res.devices,
        result:
          res.devices.length === 0
            ? { devices: 0, note: res.error ? `error: ${res.error}` : 'no DCP response — on a real network this needs a raw/mirror Ethernet adapter (L2)' }
            : {
                devices: res.devices.length,
                tree: [
                  {
                    area: `${res.devices.length} PROFINET device(s)`,
                    points: res.devices.map((d) => ({
                      ref: d.name_of_station || '(no name)',
                      value: d.ip && d.ip !== '0.0.0.0' ? d.ip : 'no IP (0.0.0.0)',
                      type: `${d.vendor || `vendor ${d.vendor_id}`} · ${d.role || 'device'}`,
                    })),
                  },
                ],
                ...a,
              },
      }),
      facts: { transport: { dcp: res.error ? 'error' : 'ok' }, dcp: a },
    };
  },

  // Browse the segment as a topology map. Joins DCP identity (who is here, what
  // IP/role) with the LLDP remote table (which port cables to which neighbour
  // port) into the physical graph; falls back to the logical DCP view when no
  // LLDP neighbours are seen.
  async browse(ctx) {
    const [res, lldp] = await Promise.all([identifyAll(ctx), collectLldp(ctx)]);
    const topology = lldp.rows.length > 0 ? buildPhysicalTopology(res.devices, lldp.rows) : buildLogicalTopology(res.devices);
    const a = analyze(res.devices);
    const linkCount = topology.links ? topology.links.length : 0;
    return {
      artifact: makeArtifact({
        verb: 'browse',
        raw: `Identify-All → ${res.devices.length} device(s); LLDP → ${lldp.rows.length} port link(s)${res.error ? ` · ${res.error}` : ''}`,
        decode: { devices: res.devices, lldp: lldp.rows },
        result: { topology, links: linkCount, ...a, note: res.devices.length === 0 ? (res.error ? `error: ${res.error}` : 'no DCP response — a real segment needs a raw/mirror Ethernet adapter (L2)') : undefined },
      }),
      facts: {},
    };
  },

  // Gate-2 preview: resolve the target's *current* name/IP so the confirm shows
  // current → proposed before anything is written (§4.1). No DCP Set is sent.
  async previewWrite(ctx) {
    const p = ctx.params || {};
    const operation = p.operation || 'set-ip';
    const target = p.target || '';
    let current = null;
    try {
      const idn = await identifyAll(ctx);
      const dev = idn.devices.find((d) => d.name_of_station === target) || (idn.devices.length === 1 ? idn.devices[0] : null);
      if (dev) current = operation === 'set-name' ? dev.name_of_station : (dev.ip && dev.ip !== '0.0.0.0' ? dev.ip : '(unconfigured)');
    } catch { /* leave current null */ }
    const proposed = operation === 'set-name' ? p.new_name : `${p.ip} / ${p.subnet} / gw ${p.gateway}`;
    return {
      point: operation === 'set-name' ? `station name · ${target || 'device'}` : `IP config · ${target || 'device'}`,
      current_value: current,
      proposed_value: proposed,
      target: `${ctx.params?.responder || ctx.host || '127.0.0.1'}${ctx.params?.responder_port ? ':' + ctx.params.responder_port : ''}`,
    };
  },

  // DCP Set — the commissioning write. Refuses unless the session is ARMED; the
  // orchestrator only calls this after Gate 1 (ARM) + Gate 2 (per-write confirm).
  async write(ctx) {
    if (!ctx.armed) throw new Error('write refused: session not ARMED (double-gate, §4.1)');
    const p = ctx.params || {};
    const operation = p.operation || 'set-ip';
    const target = p.target || '';
    const { buf, xid } = buildSet({ operation, target, name: p.new_name, ip: p.ip, subnet: p.subnet, gateway: p.gateway });
    const res = await sendSet(ctx, buf, xid);

    // Read-back (§4.1): re-run Identify-All and confirm the new value took.
    let readBack = null;
    let verified = null;
    try {
      const idn = await identifyAll(ctx);
      const wantName = operation === 'set-name' ? p.new_name : target;
      const dev = idn.devices.find((d) => d.name_of_station === wantName) || (idn.devices.length === 1 ? idn.devices[0] : null);
      if (dev) {
        readBack = operation === 'set-name' ? dev.name_of_station : dev.ip;
        verified = operation === 'set-name' ? dev.name_of_station === p.new_name : dev.ip === p.ip;
      }
    } catch { /* read-back best-effort */ }

    const proposed = operation === 'set-name' ? p.new_name : `${p.ip} / ${p.subnet} / gw ${p.gateway}`;
    const ok = res.parsed?.ok || false;
    return {
      artifact: makeArtifact({
        verb: 'write',
        raw: { tx: buf.toString('hex'), rx: res.response ? Buffer.from(res.response).toString('hex') : null },
        decode: res.parsed,
        result: {
          operation,
          target,
          proposed,
          ack: ok,
          block_error: res.parsed?.block_error_text ?? (res.error || 'no response'),
          read_back: readBack,
          verified,
          error: res.error || null,
        },
      }),
      facts: {},
      audit: {
        action: `profinet-dcp-${operation}`,
        target: `${ctx.params?.responder || ctx.host}: ${target || 'device'}`,
        point: operation === 'set-name' ? 'NameOfStation' : 'IPParameter',
        after_value: operation === 'set-name' ? p.new_name : p.ip,
        before_value: ctx.beforeValue ?? null,
      },
    };
  },

  async diagnose(ctx) {
    const res = await identifyAll(ctx);
    return {
      facts: { transport: { dcp: res.error ? 'error' : 'ok' }, dcp: analyze(res.devices) },
      rulepack: 'profinet-dcp',
      raw: `Identify-All → ${res.devices.length} device(s)${res.error ? ` · ${res.error}` : ''}`,
      decode: res.devices,
    };
  },
};
