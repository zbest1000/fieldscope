// S7comm driver (§6.2, §12 phase 6). Siemens S7-300/400/1200/1500 — the single
// most-deployed PLC family in the world, and the deepest protocol stack in the
// catalog: ISO-on-TCP (TPKT, RFC 1006) → COTP (ISO 8073) → the S7 PDU. Two field
// pains define its diagnostics and this driver targets both:
//   1. Rack/slot addressing. The COTP connection's destination TSAP encodes the
//      CPU's rack and slot; get it wrong and the PLC refuses the connection —
//      the #1 "I can ping it but can't go online" S7 call.
//   2. Identity. After the S7 "setup communication" negotiates the PDU size, an
//      SZL (System Status List) read returns the module order number (MLFB) and
//      firmware version — the "what exactly is this and what firmware" answer.
//
// Implemented raw over TCP 102. No Snap7 native dependency; the framing is
// well-specified and produces real bytes for the Raw tab.

import { tcpConnect, tcpRequest } from '../transport/transport.js';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 's7comm',
  display_name: 'S7comm (S7-300/400/1200/1500)',
  domain: 'industrial',
  group: 'industrial',
  transport: ['tcp'],
  default_port: 102,
  mode: 'full',
  lib: '🟢 raw ISO-on-TCP/COTP/S7',
  describe:
    'COTP rack/slot connection check, S7 PDU-size negotiation, SZL identity (order number + firmware), and ReadVar of a DB / memory area.',
  verbs: ['connect', 'identify', 'read', 'monitor', 'diagnose'],
  params: {
    connect: {
      rack: { type: 'number', default: 0, min: 0, max: 7 },
      slot: { type: 'number', default: 1, min: 0, max: 31 },
    },
    identify: {
      rack: { type: 'number', default: 0, min: 0, max: 31 },
      slot: { type: 'number', default: 1, min: 0, max: 31 },
    },
    // ReadVar: read `count` bytes from a data block (DB) or memory area (M / I /
    // Q), optionally interpreting them as wider big-endian types.
    read: {
      area: { type: 'enum', options: ['DB', 'M', 'I', 'Q'], default: 'DB' },
      db: { type: 'number', default: 1, min: 0, max: 65535 },
      start: { type: 'number', default: 0, min: 0, max: 65535 },
      count: { type: 'number', default: 8, min: 1, max: 222 },
      format: { type: 'enum', options: ['bytes', 'uint16', 'int16', 'uint32', 'int32', 'float32'], default: 'bytes' },
      rack: { type: 'number', default: 0, min: 0, max: 7 },
      slot: { type: 'number', default: 1, min: 0, max: 31 },
    },
  },
};

// S7 area codes and read-item return codes.
const S7_AREA = { DB: 0x84, M: 0x83, I: 0x81, Q: 0x82 };
const S7_RETURN = { 0x00: 'reserved', 0x03: 'access denied', 0x05: 'address out of range', 0x06: 'data type not supported', 0x07: 'data type inconsistent', 0x0a: 'object does not exist', 0xff: 'success' };

// ---- TPKT / COTP framing ---------------------------------------------------
function tpkt(payload) {
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from([0x03, 0x00, (len >> 8) & 0xff, len & 0xff]), payload]);
}

function tpktComplete(buf) {
  if (buf.length < 4) return false;
  const len = (buf[2] << 8) | buf[3];
  return buf.length >= len;
}

// COTP Connection Request. The destination TSAP's second byte is (rack<<5)|slot;
// its first byte is the connection type (0x01 = PG programming device).
function cotpConnectionRequest(rack, slot) {
  const dstTsap = Buffer.from([0x01, ((rack & 0x07) << 5) | (slot & 0x1f)]);
  const params = Buffer.concat([
    Buffer.from([0xc0, 0x01, 0x0a]), // TPDU size = 1024
    Buffer.from([0xc1, 0x02, 0x01, 0x00]), // source TSAP
    Buffer.concat([Buffer.from([0xc2, 0x02]), dstTsap]), // destination TSAP
  ]);
  const cotpLen = 6 + params.length; // PDU type + dstRef(2) + srcRef(2) + class + params
  const cotp = Buffer.concat([
    Buffer.from([cotpLen, 0xe0, 0x00, 0x00, 0x00, 0x01, 0x00]), // len, CR, dstRef, srcRef, class
    params,
  ]);
  return tpkt(cotp);
}

// COTP data header carrying an S7 payload.
function cotpData(s7) {
  return tpkt(Buffer.concat([Buffer.from([0x02, 0xf0, 0x80]), s7]));
}

function isConnectionConfirm(buf) {
  // TPKT(4) then COTP: [len][pduType]; CC = 0xD0.
  return buf.length >= 6 && buf[5] === 0xd0;
}

// ---- S7 PDUs ---------------------------------------------------------------
let pduRef = 0;
function nextRef() {
  pduRef = (pduRef + 1) & 0xffff;
  return pduRef;
}

// S7 "Setup Communication": negotiates max outstanding calls and PDU length.
function s7SetupCommunication() {
  const ref = nextRef();
  const params = Buffer.from([0xf0, 0x00, 0x00, 0x01, 0x00, 0x01, 0x01, 0xe0]); // AmQ 1/1, PDU 480
  const header = Buffer.alloc(10);
  header[0] = 0x32; // protocol id
  header[1] = 0x01; // ROSCTR = job
  header.writeUInt16BE(0, 2); // redundancy id
  header.writeUInt16BE(ref, 4); // pdu ref
  header.writeUInt16BE(params.length, 6); // param length
  header.writeUInt16BE(0, 8); // data length
  return cotpData(Buffer.concat([header, params]));
}

// S7 userdata "Read SZL" for a given SZL-ID and index.
function s7ReadSzl(szlId, index) {
  const ref = nextRef();
  const params = Buffer.from([0x00, 0x01, 0x12, 0x04, 0x11, 0x44, 0x01, 0x00]);
  const data = Buffer.concat([
    Buffer.from([0xff, 0x09, 0x00, 0x04]), // return code ok, octet string, length 4
    Buffer.from([(szlId >> 8) & 0xff, szlId & 0xff, (index >> 8) & 0xff, index & 0xff]),
  ]);
  const header = Buffer.alloc(10);
  header[0] = 0x32;
  header[1] = 0x07; // ROSCTR = userdata
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(ref, 4);
  header.writeUInt16BE(params.length, 6);
  header.writeUInt16BE(data.length, 8);
  return cotpData(Buffer.concat([header, params, data]));
}

// S7 ReadVar (job, function 0x04): one S7ANY item addressing `count` bytes at
// byte `start` of a DB / memory area. Addresses are bit-granular on the wire.
function s7ReadVar(area, db, start, count) {
  const ref = nextRef();
  const bitAddr = start * 8;
  const item = Buffer.from([
    0x12, 0x0a, 0x10, // var spec, len 10, syntax id S7ANY
    0x02, // transport size = BYTE
    (count >> 8) & 0xff, count & 0xff, // number of elements
    (db >> 8) & 0xff, db & 0xff, // DB number
    S7_AREA[area] ?? 0x84, // area
    (bitAddr >> 16) & 0xff, (bitAddr >> 8) & 0xff, bitAddr & 0xff, // start address (bits)
  ]);
  const params = Buffer.concat([Buffer.from([0x04, 0x01]), item]); // ReadVar, item count 1
  const header = Buffer.alloc(10);
  header[0] = 0x32;
  header[1] = 0x01; // ROSCTR = job
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(ref, 4);
  header.writeUInt16BE(params.length, 6);
  header.writeUInt16BE(0, 8);
  return cotpData(Buffer.concat([header, params]));
}

// Parse a ReadVar ack_data: one data item = return code, transport size, length,
// then the bytes (length is in bits for the BYTE/WORD transport size).
function parseReadVarResponse(buf) {
  if (buf.length < 21 || buf[7] !== 0x32) return { error: 'not-s7' };
  const paramLen = buf.readUInt16BE(13);
  const o = 19 + paramLen; // data items start after the 12-byte ack header + params
  if (o + 4 > buf.length) return { error: 'no-data-item' };
  const returnCode = buf[o];
  const transportSize = buf[o + 1];
  const lengthField = buf.readUInt16BE(o + 2);
  const byteLen = transportSize === 0x09 || transportSize === 0x07 ? lengthField : Math.ceil(lengthField / 8);
  return {
    return_code: returnCode,
    return_text: S7_RETURN[returnCode] || `0x${returnCode.toString(16)}`,
    ok: returnCode === 0xff,
    transport_size: transportSize,
    bytes: buf.subarray(o + 4, o + 4 + byteLen),
  };
}

// Render the interpreted values as an address → value table (the UI draws any
// `tree`). Stride is the byte width of each value.
function s7ValueTree(area, db, start, values, format) {
  const stride = format === 'bytes' ? 1 : format === 'uint16' || format === 'int16' ? 2 : 4;
  const label = (o) => (area === 'DB' ? `DB${db}.DBB${o}` : `${area}${o}`);
  return [{
    area: `${area === 'DB' ? `DB${db}` : area} @${start}${format !== 'bytes' ? ` · ${format}` : ''} · ${values.length} value(s)`,
    points: values.map((v, i) => ({ ref: label(start + i * stride), value: v, type: format })),
  }];
}

// Interpret raw big-endian bytes (S7 is big-endian) as a wider numeric type.
function interpretS7(bytes, format) {
  const out = [];
  if (format === 'uint16') { for (let i = 0; i + 2 <= bytes.length; i += 2) out.push(bytes.readUInt16BE(i)); return out; }
  if (format === 'int16') { for (let i = 0; i + 2 <= bytes.length; i += 2) out.push(bytes.readInt16BE(i)); return out; }
  if (format === 'uint32') { for (let i = 0; i + 4 <= bytes.length; i += 4) out.push(bytes.readUInt32BE(i)); return out; }
  if (format === 'int32') { for (let i = 0; i + 4 <= bytes.length; i += 4) out.push(bytes.readInt32BE(i)); return out; }
  if (format === 'float32') { for (let i = 0; i + 4 <= bytes.length; i += 4) out.push(Math.round(bytes.readFloatBE(i) * 1000) / 1000); return out; }
  return [...bytes]; // raw byte values
}

function parseSetupResponse(buf) {
  // TPKT(4)+COTP(3)=7, S7 header for ack_data is 12 bytes, params follow.
  if (buf.length < 27 || buf[7] !== 0x32) return { error: 'not-s7' };
  const rosctr = buf[8];
  const paramOff = 7 + 12; // ack_data header includes error class/code
  const negotiatedPdu = buf.length >= paramOff + 8 ? buf.readUInt16BE(paramOff + 6) : null;
  return { rosctr, negotiated_pdu: negotiatedPdu };
}

// SZL 0x0011 index 0x0001: module identification. First record's MlfB field
// (20 ASCII chars) is the order number; the trailing version bytes give firmware.
function parseSzlModuleId(buf) {
  if (buf.length < 17 || buf[7] !== 0x32) return null;
  const paramLen = buf.readUInt16BE(13);
  const dataOff = 17 + paramLen;
  if (buf.length < dataOff + 14) return null;
  const returnCode = buf[dataOff];
  if (returnCode !== 0xff) return { error_code: returnCode };
  const recordLen = buf.readUInt16BE(dataOff + 8);
  const recordCount = buf.readUInt16BE(dataOff + 10);
  const recStart = dataOff + 12;
  const mlfb = buf.subarray(recStart + 2, recStart + 22).toString('latin1').replace(/ +$/, '').trim();
  // The module version is encoded in the trailing bytes of the record.
  let version = null;
  if (buf.length >= recStart + 26) {
    const v1 = buf[recStart + 24];
    const v2 = buf[recStart + 25];
    version = `${v1}.${v2}`;
  }
  return { order_number: mlfb, version, record_count: recordCount, record_len: recordLen };
}

async function s7Session(ctx, { withSzl, read } = {}) {
  const timeout = ctx.params?.timeout ?? 3000;
  const rack = ctx.params?.rack ?? 0;
  const slot = ctx.params?.slot ?? 1;
  const { socket, connectMs } = await tcpConnect(ctx.host, ctx.port || 102, timeout);
  const frames = { cr: null, cc: null, setupReq: null, setupResp: null, szlReq: null, szlResp: null, readReq: null, readResp: null };
  try {
    // 1) COTP connection (rack/slot).
    const cr = cotpConnectionRequest(rack, slot);
    frames.cr = cr;
    const { data: cc, rttMs: cotpRtt } = await tcpRequest(socket, cr, { timeout, isComplete: tpktComplete });
    frames.cc = cc;
    if (!isConnectionConfirm(cc)) {
      return { cotp_ok: false, frames, connectMs, cotpRtt };
    }
    // 2) S7 setup communication (PDU negotiation).
    const setupReq = s7SetupCommunication();
    frames.setupReq = setupReq;
    const { data: setupResp, rttMs } = await tcpRequest(socket, setupReq, { timeout, isComplete: tpktComplete });
    frames.setupResp = setupResp;
    const setup = parseSetupResponse(setupResp);
    let szl = null;
    if (withSzl && !setup.error) {
      // 3) SZL 0x0011/0x0001: module identification (order number + firmware).
      const szlReq = s7ReadSzl(0x0011, 0x0001);
      frames.szlReq = szlReq;
      try {
        const { data: szlResp } = await tcpRequest(socket, szlReq, { timeout, isComplete: tpktComplete });
        frames.szlResp = szlResp;
        szl = parseSzlModuleId(szlResp);
      } catch {
        szl = null;
      }
    }
    let readResult = null;
    if (read && !setup.error) {
      // 3') ReadVar of the requested DB / memory area.
      const readReq = s7ReadVar(read.area, read.db, read.start, read.count);
      frames.readReq = readReq;
      try {
        const { data: readResp } = await tcpRequest(socket, readReq, { timeout, isComplete: tpktComplete });
        frames.readResp = readResp;
        readResult = parseReadVarResponse(readResp);
      } catch {
        readResult = null;
      }
    }
    return { cotp_ok: true, setup, szl, read: readResult, frames, connectMs, cotpRtt, rttMs };
  } finally {
    socket.destroy();
  }
}

function rawOf(frames) {
  return {
    tx: frames.cr ? Buffer.from(frames.cr).toString('hex') : null,
    rx: frames.cc ? Buffer.from(frames.cc).toString('hex') : null,
    setup_tx: frames.setupReq ? Buffer.from(frames.setupReq).toString('hex') : null,
    setup_rx: frames.setupResp ? Buffer.from(frames.setupResp).toString('hex') : null,
    szl_rx: frames.szlResp ? Buffer.from(frames.szlResp).toString('hex') : null,
    read_tx: frames.readReq ? Buffer.from(frames.readReq).toString('hex') : null,
    read_rx: frames.readResp ? Buffer.from(frames.readResp).toString('hex') : null,
  };
}

function facts(r) {
  return {
    transport: { tcp_connect: 'success' },
    cotp: { confirmed: r.cotp_ok },
    s7: r.setup && !r.setup.error ? { setup: true, pdu: r.setup.negotiated_pdu } : { setup: false },
    timeout: false,
    rtt_ms: r.rttMs ?? r.cotpRtt,
  };
}

function errorFacts(err) {
  const timeout = err.code === 'ETIMEDOUT';
  return {
    transport: { tcp_connect: timeout ? 'success' : 'fail', error: err.code || err.message },
    cotp: { confirmed: false },
    s7: { setup: false },
    timeout,
  };
}

export const verbs = {
  // Connect = COTP (rack/slot) + S7 setup communication (PDU negotiation).
  async connect(ctx) {
    try {
      const r = await s7Session(ctx, { withSzl: false });
      return {
        artifact: makeArtifact({
          verb: 'connect',
          raw: rawOf(r.frames),
          result: {
            cotp_confirmed: r.cotp_ok,
            rack: ctx.params?.rack ?? 0,
            slot: ctx.params?.slot ?? 1,
            s7_setup: r.setup ? !r.setup.error : false,
            negotiated_pdu: r.setup ? r.setup.negotiated_pdu : null,
            connect_ms: r.connectMs,
          },
        }),
        facts: facts(r),
      };
    } catch (err) {
      return {
        artifact: makeArtifact({
          verb: 'connect',
          raw: `error: ${err.code || err.message}`,
          result: { cotp_confirmed: false, error: err.code || err.message },
          error: err,
        }),
        facts: errorFacts(err),
      };
    }
  },

  // Identify = connect + SZL module identification (order number + firmware).
  async identify(ctx) {
    try {
      const r = await s7Session(ctx, { withSzl: true });
      if (!r.cotp_ok) {
        return {
          artifact: makeArtifact({
            verb: 'identify',
            raw: rawOf(r.frames),
            result: { cotp_confirmed: false, note: 'COTP refused — check rack/slot' },
          }),
          facts: facts(r),
        };
      }
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: rawOf(r.frames),
          decode: r.szl,
          result: {
            order_number: r.szl ? r.szl.order_number : null,
            firmware: r.szl ? r.szl.version : null,
            negotiated_pdu: r.setup ? r.setup.negotiated_pdu : null,
            rack: ctx.params?.rack ?? 0,
            slot: ctx.params?.slot ?? 1,
          },
        }),
        facts: facts(r),
      };
    } catch (err) {
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: `error: ${err.code || err.message}`,
          result: { error: err.code || err.message },
          error: err,
        }),
        facts: errorFacts(err),
      };
    }
  },

  // Read = COTP + setup + ReadVar of a DB / memory area, optionally interpreted.
  async read(ctx) {
    const area = ctx.params?.area ?? 'DB';
    const db = ctx.params?.db ?? 1;
    const start = ctx.params?.start ?? 0;
    const count = ctx.params?.count ?? 8;
    const format = ctx.params?.format ?? 'bytes';
    try {
      const r = await s7Session(ctx, { read: { area, db, start, count } });
      if (!r.cotp_ok) {
        return {
          artifact: makeArtifact({ verb: 'read', raw: rawOf(r.frames), result: { cotp_confirmed: false, note: 'COTP refused — check rack/slot' } }),
          facts: facts(r),
        };
      }
      const rd = r.read;
      const ok = !!(rd && rd.ok);
      const addr = area === 'DB' ? `DB${db}.DBB${start}` : `${area}${start}`;
      return {
        artifact: makeArtifact({
          verb: 'read',
          raw: rawOf(r.frames),
          decode: rd,
          result: {
            area,
            db: area === 'DB' ? db : undefined,
            start,
            count,
            format,
            address: addr,
            status: rd ? rd.return_text : 'no response',
            values: ok ? interpretS7(rd.bytes, format) : null,
            tree: ok ? s7ValueTree(area, db, start, interpretS7(rd.bytes, format), format) : undefined,
            bytes: ok ? rd.bytes.toString('hex') : undefined,
            negotiated_pdu: r.setup ? r.setup.negotiated_pdu : null,
          },
        }),
        facts: facts(r),
      };
    } catch (err) {
      return {
        artifact: makeArtifact({ verb: 'read', raw: `error: ${err.code || err.message}`, result: { error: err.code || err.message }, error: err }),
        facts: errorFacts(err),
      };
    }
  },

  async monitorSample(ctx) {
    try {
      const r = await s7Session(ctx, { withSzl: false });
      return { value: r.rttMs ?? r.cotpRtt, ok: r.cotp_ok && !!(r.setup && !r.setup.error), raw: rawOf(r.frames) };
    } catch (err) {
      return { value: null, ok: false, raw: `error: ${err.code || err.message}` };
    }
  },

  async diagnose(ctx) {
    try {
      const r = await s7Session(ctx, { withSzl: false });
      return { facts: facts(r), rulepack: 's7comm', raw: rawOf(r.frames) };
    } catch (err) {
      return { facts: errorFacts(err), rulepack: 's7comm', raw: `error: ${err.code || err.message}` };
    }
  },
};

export { cotpConnectionRequest, parseSetupResponse, parseSzlModuleId };
