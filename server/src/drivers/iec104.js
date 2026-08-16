// IEC 60870-5-104 driver (§6.3, utility SCADA). The European utility-telecontrol
// flagship — IEC 60870-5-101's application layer carried over TCP/IP (port 2404).
// A fifth distinct protocol shape: an APCI (Application Protocol Control
// Information) envelope with three frame formats — U (unnumbered control:
// STARTDT / STOPDT / TESTFR), S (supervisory ack), and I (information transfer,
// carrying an ASDU with send/receive sequence numbers) — wrapping the ASDU whose
// Cause of Transmission (COT) and Common Address are exactly what a telecontrol
// engineer reads to answer "why won't the SCADA master integrate this RTU."
//
// Two exchanges, both raw over TCP:
//   - STARTDT act → con: the master must activate data transfer before the RTU
//     sends anything. No STARTDT con = the classic "connected but silent" fault.
//   - General Interrogation (C_IC_NA_1): the master's station-wide poll. Its
//     activation-confirm / data / activation-termination sequence, and the
//     unknown-common-address reject (COT 46), are the primary health signals.

import { tcpConnect } from '../transport/transport.js';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'iec104',
  display_name: 'IEC 60870-5-104',
  domain: 'utility',
  group: 'utility',
  transport: ['tcp'],
  default_port: 2404,
  mode: 'full',
  lib: '🟢 raw APCI/ASDU',
  describe:
    'STARTDT activation + General Interrogation with COT verdicts (link not activated, wrong common address, GI rejected, points returned).',
  verbs: ['connect', 'identify', 'browse', 'read', 'monitor', 'diagnose'],
  params: {
    connect: { common_address: { type: 'number', default: 1, min: 0, max: 65535 }, timeout: { type: 'number', default: 3000, min: 500, max: 10000 } },
    identify: { common_address: { type: 'number', default: 1, min: 0, max: 65535 }, timeout: { type: 'number', default: 3000, min: 500, max: 10000 } },
    browse: { common_address: { type: 'number', default: 1, min: 0, max: 65535 }, timeout: { type: 'number', default: 3000, min: 500, max: 10000 } },
    read: { common_address: { type: 'number', default: 1, min: 0, max: 65535 }, timeout: { type: 'number', default: 3000, min: 500, max: 10000 } },
    monitor: { common_address: { type: 'number', default: 1, min: 0, max: 65535 }, timeout: { type: 'number', default: 3000, min: 500, max: 10000 } },
    diagnose: { common_address: { type: 'number', default: 1, min: 0, max: 65535 }, timeout: { type: 'number', default: 3000, min: 500, max: 10000 } },
  },
};

const START = 0x68;
// U-format control-field function octets (octet 1; octets 2-4 are zero).
const U = { STARTDT_act: 0x07, STARTDT_con: 0x0b, STOPDT_act: 0x13, STOPDT_con: 0x23, TESTFR_act: 0x43, TESTFR_con: 0x83 };
const U_NAME = Object.fromEntries(Object.entries(U).map(([k, v]) => [v, k]));
// Type identifications we decode (monitor + system + the GI command).
const TYPE = {
  1: 'M_SP_NA_1 (single-point)', 3: 'M_DP_NA_1 (double-point)', 9: 'M_ME_NA_1 (measured, normalized)',
  11: 'M_ME_NB_1 (measured, scaled)', 13: 'M_ME_NC_1 (measured, short float)', 30: 'M_SP_TB_1 (single-point +time)',
  70: 'M_EI_NA_1 (end of init)', 100: 'C_IC_NA_1 (interrogation command)', 45: 'C_SC_NA_1 (single command)',
};
// Cause of transmission (COT, low 6 bits).
const COT = {
  1: 'periodic', 2: 'background', 3: 'spontaneous', 4: 'initialized', 5: 'request', 6: 'activation',
  7: 'activation-confirmation', 8: 'deactivation', 9: 'deactivation-confirmation', 10: 'activation-termination',
  20: 'interrogated-by-station', 44: 'unknown-type-id', 45: 'unknown-cause', 46: 'unknown-common-address', 47: 'unknown-ioa',
};

// ---- APCI builders ---------------------------------------------------------
export function buildU(func) {
  return Buffer.from([START, 0x04, func, 0x00, 0x00, 0x00]);
}
export function buildS(nr) {
  const b = Buffer.alloc(6);
  b[0] = START; b[1] = 0x04; b[2] = 0x01; // S-format
  b.writeUInt16LE((nr << 1) & 0xfffe, 4);
  return b;
}
export function buildI(ns, nr, asdu) {
  const ctrl = Buffer.alloc(4);
  ctrl.writeUInt16LE((ns << 1) & 0xfffe, 0);
  ctrl.writeUInt16LE((nr << 1) & 0xfffe, 2);
  const body = Buffer.concat([ctrl, asdu]);
  return Buffer.concat([Buffer.from([START, body.length]), body]);
}

// Build the General Interrogation command ASDU (C_IC_NA_1, QOI=20 station).
export function buildInterrogationAsdu(commonAddress) {
  const ca = Buffer.alloc(2); ca.writeUInt16LE(commonAddress & 0xffff, 0);
  return Buffer.concat([
    Buffer.from([100, 0x01]), // type C_IC_NA_1, VSQ = 1 object (SQ=0)
    Buffer.from([0x06, 0x00]), // COT = 6 (activation), originator 0
    ca,
    Buffer.from([0x00, 0x00, 0x00]), // IOA = 0
    Buffer.from([0x14]), // QOI = 20 (global/station interrogation)
  ]);
}

// ---- parsing ---------------------------------------------------------------
// Split a byte stream into complete APDUs (start + length-prefixed).
export function splitApdus(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    if (buf[off] !== START) { off += 1; continue; } // resync on stray bytes
    const len = buf[off + 1];
    if (off + 2 + len > buf.length) break;
    frames.push(buf.subarray(off, off + 2 + len));
    off += 2 + len;
  }
  return { frames, rest: buf.subarray(off) };
}

const ELEM = { 1: 1, 3: 1, 9: 3, 11: 3, 13: 5, 30: 8, 45: 2, 100: 2, 70: 1 };

function decodeElement(typeId, buf) {
  switch (typeId) {
    case 1: return { value: buf[0] & 0x01, quality: qualityBits(buf[0]) }; // SIQ
    case 3: return { value: buf[0] & 0x03, quality: qualityBits(buf[0]) }; // DIQ
    case 9: return { value: buf.readInt16LE(0) / 32768, quality: qualityBits(buf[2]) }; // normalized
    case 11: return { value: buf.readInt16LE(0), quality: qualityBits(buf[2]) }; // scaled
    case 13: return { value: round(buf.readFloatLE(0)), quality: qualityBits(buf[4]) }; // short float
    case 100: return { qoi: buf[1] };
    default: return { raw: buf.toString('hex') };
  }
}
function qualityBits(b) {
  return { invalid: !!(b & 0x80), not_topical: !!(b & 0x40), substituted: !!(b & 0x20), blocked: !!(b & 0x10) };
}
const round = (n) => Math.round(n * 1000) / 1000;

export function parseAsdu(buf) {
  if (buf.length < 6) return { error: 'short-asdu' };
  const typeId = buf[0];
  const vsq = buf[1];
  const numObjects = vsq & 0x7f;
  const sq = !!(vsq & 0x80);
  const cotByte = buf[2];
  const cot = cotByte & 0x3f;
  const negative = !!(cotByte & 0x40);
  const test = !!(cotByte & 0x80);
  const originator = buf[3];
  const commonAddress = buf.readUInt16LE(4);
  const objects = [];
  const size = ELEM[typeId] ?? null;
  let o = 6;
  if (size != null) {
    if (sq) {
      // Sequence: one base IOA, then N consecutive elements.
      if (o + 3 <= buf.length) {
        const baseIoa = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
        o += 3;
        for (let i = 0; i < numObjects && o + size <= buf.length; i++, o += size) {
          objects.push({ ioa: baseIoa + i, ...decodeElement(typeId, buf.subarray(o, o + size)) });
        }
      }
    } else {
      for (let i = 0; i < numObjects && o + 3 + size <= buf.length; i++) {
        const ioa = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
        o += 3;
        objects.push({ ioa, ...decodeElement(typeId, buf.subarray(o, o + size)) });
        o += size;
      }
    }
  }
  return {
    type_id: typeId, type: TYPE[typeId] || `type ${typeId}`, num_objects: numObjects, sq,
    cot, cot_name: COT[cot] || `cot ${cot}`, negative, test, originator, common_address: commonAddress, objects,
  };
}

export function parseApdu(frame) {
  const hex = Buffer.from(frame).toString('hex');
  if (frame.length < 6) return { format: 'invalid', hex };
  const c1 = frame[2];
  if ((c1 & 0x01) === 0) {
    return { format: 'I', ns: (frame.readUInt16LE(2) >> 1) & 0x7fff, nr: (frame.readUInt16LE(4) >> 1) & 0x7fff, asdu: parseAsdu(frame.subarray(6)), hex };
  }
  if ((c1 & 0x03) === 0x01) {
    return { format: 'S', nr: (frame.readUInt16LE(4) >> 1) & 0x7fff, hex };
  }
  return { format: 'U', u: U_NAME[c1] || `U(0x${c1.toString(16)})`, hex };
}

// ---- socket exchange -------------------------------------------------------
// Collect parsed APDUs off a socket until `until(apdus)` or the timeout fires.
function collect(socket, { until, timeout }) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    let acc = Buffer.alloc(0);
    const apdus = [];
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); socket.removeListener('data', onData); socket.removeListener('error', onError); fn(arg); };
    const onData = (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      const { frames, rest } = splitApdus(acc);
      acc = rest;
      for (const f of frames) apdus.push(parseApdu(f));
      if (until(apdus)) done(resolve, { apdus, rttMs: Number(process.hrtime.bigint() - started) / 1e6 });
    };
    const onError = (err) => done(reject, err);
    const timer = setTimeout(() => {
      if (apdus.length) done(resolve, { apdus, rttMs: Number(process.hrtime.bigint() - started) / 1e6, partial: true });
      else done(reject, tagged('ETIMEDOUT', `no IEC-104 response after ${timeout}ms`));
    }, timeout);
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

function tagged(code, message) { const e = new Error(message); e.code = code; return e; }

// STARTDT handshake only.
async function startdt(ctx, timeout) {
  const { socket, connectMs } = await tcpConnect(ctx.host, ctx.port || 2404, timeout);
  try {
    const req = buildU(U.STARTDT_act);
    socket.write(req);
    const { apdus, rttMs } = await collect(socket, { until: (a) => a.some((x) => x.format === 'U' && x.u === 'STARTDT_con'), timeout });
    return { connectMs, rttMs, apdus, request: req, confirmed: apdus.some((x) => x.u === 'STARTDT_con') };
  } finally { socket.destroy(); }
}

// STARTDT then a General Interrogation, collecting the whole GI sequence.
async function interrogate(ctx, timeout) {
  const commonAddress = ctx.params?.common_address ?? 1;
  const { socket, connectMs } = await tcpConnect(ctx.host, ctx.port || 2404, timeout);
  try {
    const startReq = buildU(U.STARTDT_act);
    socket.write(startReq);
    const s = await collect(socket, { until: (a) => a.some((x) => x.u === 'STARTDT_con'), timeout });
    if (!s.apdus.some((x) => x.u === 'STARTDT_con')) {
      return { connectMs, startdt_confirmed: false, apdus: s.apdus, common_address: commonAddress, request: startReq };
    }
    const giReq = buildI(0, s.apdus.filter((x) => x.format === 'I').length, buildInterrogationAsdu(commonAddress));
    socket.write(giReq);
    const g = await collect(socket, {
      // Done when GI terminates, or the station rejects it (unknown CA / negative confirm).
      until: (a) => a.some((x) => x.format === 'I' && x.asdu && (
        (x.asdu.type_id === 100 && x.asdu.cot === 10) ||
        x.asdu.cot === 46 ||
        (x.asdu.type_id === 100 && x.asdu.cot === 7 && x.asdu.negative)
      )),
      timeout,
    });
    return { connectMs, startdt_confirmed: true, apdus: g.apdus, common_address: commonAddress, request: giReq, rttMs: g.rttMs };
  } finally { socket.destroy(); }
}

function analyzeGI(apdus) {
  const iFrames = apdus.filter((x) => x.format === 'I' && x.asdu && !x.asdu.error);
  const con = iFrames.find((x) => x.asdu.type_id === 100 && x.asdu.cot === 7);
  const term = iFrames.find((x) => x.asdu.type_id === 100 && x.asdu.cot === 10);
  const unknownCA = iFrames.find((x) => x.asdu.cot === 46);
  const data = iFrames.filter((x) => x.asdu.cot === 20 || x.asdu.cot === 3);
  const points = data.flatMap((x) => x.asdu.objects.map((o) => ({ ...o, type: x.asdu.type })));
  return {
    activation_confirmed: !!con && !con.asdu.negative,
    negative: !!(con && con.asdu.negative),
    terminated: !!term,
    unknown_common_address: !!unknownCA,
    point_count: points.length,
    types: [...new Set(data.map((x) => x.asdu.type))],
    points,
  };
}

function giFacts(res) {
  const gi = analyzeGI(res.apdus);
  return {
    transport: { tcp_connect: 'success' },
    startdt: { confirmed: res.startdt_confirmed },
    interrogation: {
      activation_confirmed: gi.activation_confirmed,
      negative: gi.negative,
      terminated: gi.terminated,
      unknown_common_address: gi.unknown_common_address,
      points: gi.point_count,
    },
    common_address: res.common_address,
    timeout: false,
  };
}

function errorFacts(err) {
  const timeout = err.code === 'ETIMEDOUT';
  return {
    transport: { tcp_connect: timeout ? 'success' : 'fail', error: err.code || err.message },
    startdt: { confirmed: false },
    interrogation: { activation_confirmed: false, points: 0 },
    timeout,
  };
}

const bytes = (req, res) => ({ tx: req ? Buffer.from(req).toString('hex') : null, rx: res ? Buffer.from(res).toString('hex') : null });

export const verbs = {
  // Connect = STARTDT handshake: the RTU won't send anything until the master
  // activates data transfer, so a missing STARTDT con is the "silent link" fault.
  async connect(ctx) {
    const timeout = ctx.params?.timeout ?? 3000;
    try {
      const r = await startdt(ctx, timeout);
      return {
        artifact: makeArtifact({
          verb: 'connect',
          raw: bytes(r.request, r.apdus[0]?.hex ? Buffer.from(r.apdus[0].hex, 'hex') : null),
          decode: r.apdus,
          result: { startdt_confirmed: r.confirmed, connect_ms: round(r.connectMs), rtt_ms: round(r.rttMs) },
        }),
        facts: { transport: { tcp_connect: 'success' }, startdt: { confirmed: r.confirmed }, interrogation: { activation_confirmed: false, points: 0 }, timeout: false },
      };
    } catch (err) {
      return { artifact: makeArtifact({ verb: 'connect', raw: `error: ${err.code || err.message}`, result: { startdt_confirmed: false, error: err.code || err.message }, error: err }), facts: errorFacts(err) };
    }
  },

  // Identify = STARTDT + GI, summarized (common address, confirm/termination,
  // point count, the ASDU types the RTU carries).
  async identify(ctx) {
    const timeout = ctx.params?.timeout ?? 3000;
    try {
      const r = await interrogate(ctx, timeout);
      const gi = analyzeGI(r.apdus);
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: bytes(r.request, null),
          decode: r.apdus,
          result: {
            common_address: r.common_address,
            startdt_confirmed: r.startdt_confirmed,
            gi_confirmed: gi.activation_confirmed,
            gi_terminated: gi.terminated,
            unknown_common_address: gi.unknown_common_address,
            points: gi.point_count,
            types: gi.types,
          },
        }),
        facts: giFacts(r),
      };
    } catch (err) {
      return { artifact: makeArtifact({ verb: 'identify', raw: `error: ${err.code || err.message}`, result: { error: err.code || err.message }, error: err }), facts: errorFacts(err) };
    }
  },

  // Browse / Read = the General Interrogation point list as a table.
  async browse(ctx) { return readPoints(ctx); },
  async read(ctx) { return readPoints(ctx); },

  async monitorSample(ctx) {
    const timeout = ctx.params?.timeout ?? 3000;
    try {
      const { socket, connectMs } = await tcpConnect(ctx.host, ctx.port || 2404, timeout);
      try {
        socket.write(buildU(U.STARTDT_act));
        await collect(socket, { until: (a) => a.some((x) => x.u === 'STARTDT_con'), timeout });
        socket.write(buildU(U.TESTFR_act));
        const t = await collect(socket, { until: (a) => a.some((x) => x.u === 'TESTFR_con'), timeout });
        return { value: round(t.rttMs), ok: true, raw: bytes(buildU(U.TESTFR_act), null) };
      } finally { socket.destroy(); }
    } catch (err) {
      return { value: null, ok: false, raw: `error: ${err.code || err.message}` };
    }
  },

  async diagnose(ctx) {
    const timeout = ctx.params?.timeout ?? 3000;
    try {
      const r = await interrogate(ctx, timeout);
      return { facts: giFacts(r), rulepack: 'iec104', raw: bytes(r.request, null), decode: r.apdus };
    } catch (err) {
      return { facts: errorFacts(err), rulepack: 'iec104', raw: `error: ${err.code || err.message}` };
    }
  },
};

async function readPoints(ctx) {
  const timeout = ctx.params?.timeout ?? 3000;
  try {
    const r = await interrogate(ctx, timeout);
    const gi = analyzeGI(r.apdus);
    return {
      artifact: makeArtifact({
        verb: 'read',
        raw: bytes(r.request, null),
        decode: gi.points,
        result: gi.points.length
          ? {
              points: gi.point_count,
              tree: [{
                area: `common address ${r.common_address} · ${gi.point_count} point(s)`,
                points: gi.points.map((p) => ({
                  ref: `IOA ${p.ioa}`,
                  value: p.value ?? p.raw ?? '—',
                  type: `${p.type}${p.quality?.invalid ? ' · INVALID' : ''}`,
                })),
              }],
              types: gi.types,
            }
          : { points: 0, note: gi.unknown_common_address ? `station rejected common address ${r.common_address} (COT 46)` : (r.startdt_confirmed ? 'GI returned no points' : 'STARTDT not confirmed') },
      }),
      facts: giFacts(r),
    };
  } catch (err) {
    return { artifact: makeArtifact({ verb: 'read', raw: `error: ${err.code || err.message}`, result: { error: err.code || err.message }, error: err }), facts: errorFacts(err) };
  }
}
