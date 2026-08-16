// PROFINET DCP driver (§6.2) — the PRONETA-style "who is on this segment"
// discovery. DCP (Discovery and Configuration Protocol) is how a commissioning
// tool finds PROFINET devices, reads their station name / IP / vendor / role,
// flashes a device's LED, and assigns names and addresses. Its flagship
// diagnostic is exactly the commissioning pain: a brand-new device that has a
// name but no IP (0.0.0.0), or two devices sharing one station name.
//
// Honest transport note (§10, §11): real DCP rides *raw Ethernet* — a Layer-2
// multicast, EtherType 0x8892 — so it needs a raw/mirror adapter and admin
// rights (declared requires_l2 / requires_admin). This build implements the DCP
// PDU codec (the substance — the frame knowledge Wireshark-grade decoders carry)
// and exercises it over a UDP test responder (the sim lab, or a DCP-over-UDP
// gateway). On a live plant network the same codec is driven over the L2 socket.

import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'profinet-dcp',
  display_name: 'PROFINET DCP (PRONETA-style)',
  domain: 'industrial',
  group: 'industrial',
  transport: ['l2'],
  default_port: null,
  requires_l2: true,
  requires_admin: true,
  mode: 'full',
  lib: '🟡 raw Ethernet (0x8892)',
  describe: 'Identify-All device discovery (station name / IP / MAC / vendor / role) + DCP block decode. Needs a raw/mirror Ethernet adapter on real networks.',
  verbs: ['identify', 'diagnose'],
  params: {
    identify: {
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
const ROLE = { 0x00: 'none', 0x01: 'IO-Device', 0x02: 'IO-Controller', 0x04: 'IO-Multidevice', 0x08: 'PN-Supervisor' };

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
