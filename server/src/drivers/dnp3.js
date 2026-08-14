// DNP3 driver (§6.3, §12 phase 6). The North-American utility/SCADA flagship,
// and a fourth distinct protocol shape: a three-layer stack (data link →
// transport → application) with a per-block CRC on the wire. The diagnostic
// payload is the outstation's IIN (Internal Indications) word — the two bytes
// that tell you it restarted, wants a time sync, has a corrupt configuration,
// or has events waiting. That word is exactly what a field engineer reads to
// answer "why won't the master integrate this RTU."
//
// Implemented raw over TCP 20000 (the registered DNP3 port). Two exchanges:
//   - Link Status (data-link function 9 → 11): proves the outstation answers at
//     its DNP3 link address — a wrong link/master address is a classic fault.
//   - Class 0 READ (application): pulls the IIN flags for the health verdict.

import { tcpConnect, tcpRequest } from '../transport/transport.js';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'dnp3',
  display_name: 'DNP3',
  domain: 'utility',
  group: 'utility',
  transport: ['tcp'],
  default_port: 20000,
  mode: 'full',
  lib: '🟢 raw link/transport/app',
  describe:
    'Link-status addressing check and Class 0 integrity read with IIN-flag verdicts (restart, time-sync, config-corrupt, events).',
  verbs: ['connect', 'identify', 'monitor', 'diagnose'],
  params: {
    connect: {
      source: { type: 'number', default: 1, min: 0, max: 65519 },
      destination: { type: 'number', default: 1024, min: 0, max: 65519 },
    },
    identify: {
      source: { type: 'number', default: 1, min: 0, max: 65519 },
      destination: { type: 'number', default: 1024, min: 0, max: 65519 },
    },
  },
};

// ---- DNP3 CRC (IEEE 1815). Reflected poly 0xA6BC, final XOR 0xFFFF. ---------
function dnp3Crc(buf) {
  let crc = 0;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa6bc : crc >>> 1;
    }
  }
  return (~crc) & 0xffff;
}

function appendCrc(block) {
  const crc = dnp3Crc(block);
  return Buffer.concat([block, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}

// ---- data-link framing -----------------------------------------------------
// Header block: 05 64, length, control, dest(LE16), src(LE16), CRC. `length`
// counts the control + address bytes plus all user-data bytes (not the CRCs).
function buildFrame(control, dest, src, userData = Buffer.alloc(0)) {
  const header = Buffer.alloc(8);
  header[0] = 0x05;
  header[1] = 0x64;
  header[2] = 5 + userData.length; // control(1) + dst(2) + src(2) + userData
  header[3] = control;
  header.writeUInt16LE(dest & 0xffff, 4);
  header.writeUInt16LE(src & 0xffff, 6);
  const frame = [appendCrc(header)];
  // User data is CRC'd in blocks of up to 16 bytes.
  for (let off = 0; off < userData.length; off += 16) {
    frame.push(appendCrc(userData.subarray(off, off + 16)));
  }
  return Buffer.concat(frame);
}

// A frame is complete once we have the header block plus every data block.
function frameComplete(buf) {
  if (buf.length < 10) return false;
  if (buf[0] !== 0x05 || buf[1] !== 0x64) return false;
  const userLen = Math.max(0, buf[2] - 5);
  const blocks = Math.ceil(userLen / 16);
  return buf.length >= 10 + userLen + blocks * 2;
}

function parseFrame(buf) {
  if (buf.length < 10 || buf[0] !== 0x05 || buf[1] !== 0x64) return { error: 'not-a-dnp3-frame' };
  const length = buf[2];
  const control = buf[3];
  const dest = buf.readUInt16LE(4);
  const src = buf.readUInt16LE(6);
  const headerCrcOk = dnp3Crc(buf.subarray(0, 8)) === buf.readUInt16LE(8);
  const userLen = Math.max(0, length - 5);
  // Strip the per-block CRCs to recover the user data.
  const data = [];
  let off = 10;
  let remaining = userLen;
  let crcOk = headerCrcOk;
  while (remaining > 0 && off + 2 <= buf.length) {
    const take = Math.min(16, remaining);
    const block = buf.subarray(off, off + take);
    if (off + take + 2 <= buf.length) {
      crcOk = crcOk && dnp3Crc(block) === buf.readUInt16LE(off + take);
    }
    data.push(block);
    off += take + 2;
    remaining -= take;
  }
  return {
    control,
    prm: !!(control & 0x40),
    dir: !!(control & 0x80),
    function_code: control & 0x0f,
    dest,
    src,
    crc_ok: crcOk,
    user_data: Buffer.concat(data),
  };
}

// ---- application-layer IIN decode ------------------------------------------
function decodeIIN(iin1, iin2) {
  return {
    // IIN1
    all_stations: !!(iin1 & 0x01),
    class1_events: !!(iin1 & 0x02),
    class2_events: !!(iin1 & 0x04),
    class3_events: !!(iin1 & 0x08),
    need_time: !!(iin1 & 0x10),
    local_control: !!(iin1 & 0x20),
    device_trouble: !!(iin1 & 0x40),
    device_restart: !!(iin1 & 0x80),
    // IIN2
    function_not_supported: !!(iin2 & 0x01),
    object_unknown: !!(iin2 & 0x02),
    parameter_error: !!(iin2 & 0x04),
    event_buffer_overflow: !!(iin2 & 0x08),
    already_executing: !!(iin2 & 0x10),
    config_corrupt: !!(iin2 & 0x20),
  };
}

// READ Class 0: transport(FIR|FIN|seq), app(FIR|FIN|seq), func READ, then
// object group 60 var 1 (Class 0 data), qualifier 0x06 (all points).
function buildClass0Read() {
  const transport = Buffer.from([0xc0]); // FIR=1, FIN=1, seq=0
  const app = Buffer.from([0xc0, 0x01, 60, 0x01, 0x06]); // ctrl, READ, g60v1, all
  return Buffer.concat([transport, app]);
}

function parseAppResponse(userData) {
  if (userData.length < 4) return { error: 'short-application-response' };
  // userData[0] is the transport header; application starts at 1.
  const appCtrl = userData[1];
  const func = userData[2];
  const iin1 = userData[3];
  const iin2 = userData[4] ?? 0;
  return {
    app_control: appCtrl,
    function_code: func,
    is_response: func === 0x81 || func === 0x82,
    iin1,
    iin2,
    iin: decodeIIN(iin1, iin2),
  };
}

async function transact(host, port, frame, timeout) {
  const { socket, connectMs } = await tcpConnect(host, port, timeout);
  try {
    const { data, rttMs } = await tcpRequest(socket, frame, { timeout, isComplete: frameComplete });
    return { response: data, connectMs, rttMs };
  } finally {
    socket.destroy();
  }
}

function bytesRaw(req, res) {
  return {
    tx: req ? Buffer.from(req).toString('hex') : null,
    rx: res ? Buffer.from(res).toString('hex') : null,
  };
}

async function linkStatus(ctx, timeout) {
  const src = ctx.params?.source ?? 1;
  const dest = ctx.params?.destination ?? 1024;
  // DIR=1 (from master), PRM=1, function 9 (Request Link Status) = 0xC9.
  const frame = buildFrame(0xc9, dest, src, Buffer.alloc(0));
  const { response, connectMs, rttMs } = await transact(ctx.host, ctx.port || 20000, frame, timeout);
  return { request: frame, response, parsed: parseFrame(response), connectMs, rttMs };
}

async function class0(ctx, timeout) {
  const src = ctx.params?.source ?? 1;
  const dest = ctx.params?.destination ?? 1024;
  // DIR=1, PRM=1, function 4 (Unconfirmed User Data) = 0xC4.
  const frame = buildFrame(0xc4, dest, src, buildClass0Read());
  const { response, rttMs } = await transact(ctx.host, ctx.port || 20000, frame, timeout);
  const parsed = parseFrame(response);
  const app = parsed.error ? null : parseAppResponse(parsed.user_data);
  return { request: frame, response, parsed, app, rttMs };
}

function iinFacts(app, rttMs) {
  return {
    transport: { tcp_connect: 'success' },
    application: app ? { received: true } : { received: false },
    iin: app ? app.iin : {},
    timeout: false,
    rtt_ms: rttMs,
  };
}

function errorFacts(err) {
  const timeout = err.code === 'ETIMEDOUT';
  return {
    transport: { tcp_connect: timeout ? 'success' : 'fail', error: err.code || err.message },
    application: { received: false },
    timeout,
  };
}

export const verbs = {
  // Connect = Link Status exchange: proves the outstation answers at its DNP3
  // link address (a wrong link/master address is silent, like an offline RTU).
  async connect(ctx) {
    const timeout = ctx.params?.timeout ?? 3000;
    try {
      const r = await linkStatus(ctx, timeout);
      const ok = !r.parsed.error && r.parsed.function_code === 11; // Link Status
      return {
        artifact: makeArtifact({
          verb: 'connect',
          raw: bytesRaw(r.request, r.response),
          decode: r.parsed,
          result: {
            link_confirmed: ok,
            outstation_address: r.parsed.src,
            master_address: r.parsed.dest,
            crc_ok: r.parsed.crc_ok,
            rtt_ms: r.rttMs,
          },
        }),
        facts: { transport: { tcp_connect: 'success' }, link_status: ok },
      };
    } catch (err) {
      return {
        artifact: makeArtifact({
          verb: 'connect',
          raw: `error: ${err.code || err.message}`,
          result: { link_confirmed: false, error: err.code || err.message },
          error: err,
        }),
        facts: errorFacts(err),
      };
    }
  },

  // Identify = Class 0 integrity read, decoded to the IIN word.
  async identify(ctx) {
    const timeout = ctx.params?.timeout ?? 3000;
    try {
      const r = await class0(ctx, timeout);
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: bytesRaw(r.request, r.response),
          decode: r.app,
          result: r.app
            ? {
                outstation_address: r.parsed.src,
                iin_flags: Object.entries(r.app.iin).filter(([, v]) => v).map(([k]) => k),
                iin_raw: `0x${r.app.iin1.toString(16).padStart(2, '0')}${r.app.iin2.toString(16).padStart(2, '0')}`,
                rtt_ms: r.rttMs,
              }
            : { application: null, note: 'no valid application response' },
        }),
        facts: iinFacts(r.app, r.rttMs),
      };
    } catch (err) {
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: `error: ${err.code || err.message}`,
          result: { application: null, error: err.code || err.message },
          error: err,
        }),
        facts: errorFacts(err),
      };
    }
  },

  async monitorSample(ctx) {
    try {
      const r = await linkStatus(ctx, ctx.params?.timeout ?? 3000);
      const ok = !r.parsed.error && r.parsed.function_code === 11;
      return { value: r.rttMs, ok, raw: bytesRaw(r.request, r.response) };
    } catch (err) {
      return { value: null, ok: false, raw: `error: ${err.code || err.message}` };
    }
  },

  async diagnose(ctx) {
    const timeout = ctx.params?.timeout ?? 3000;
    try {
      const r = await class0(ctx, timeout);
      if (!r.app) {
        return {
          facts: { transport: { tcp_connect: 'success' }, application: { received: false }, timeout: false },
          rulepack: 'dnp3',
          raw: bytesRaw(r.request, r.response),
        };
      }
      return { facts: iinFacts(r.app, r.rttMs), rulepack: 'dnp3', raw: bytesRaw(r.request, r.response), decode: r.app };
    } catch (err) {
      return { facts: errorFacts(err), rulepack: 'dnp3', raw: `error: ${err.code || err.message}` };
    }
  },
};

export { dnp3Crc, buildFrame, parseFrame, decodeIIN };
