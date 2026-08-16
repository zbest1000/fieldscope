// Modbus TCP driver (§6.2, §12 phase 3). Highest-demand industrial protocol;
// validates the contract against a very different shape from the IT tier.
//
// Modbus TCP framing is simple enough to implement directly (MBAP header + PDU),
// which keeps the MVP dependency-free while still producing real bytes-on-wire
// for the Raw tab and real exception-code verdicts for Diagnose.
//
// Read verbs are always available. Write verbs (FC05/FC06) are declared
// write_capable and gated by the orchestrator behind the double-gate (§4.1);
// the driver simply refuses to build a write frame unless ctx.armed is true.

import { tcpConnect, tcpRequest } from '../transport/transport.js';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'modbus-tcp',
  display_name: 'Modbus TCP',
  domain: 'industrial',
  group: 'industrial',
  transport: ['tcp'],
  default_port: 502,
  write_capable: true,
  mode: 'full',
  lib: '🟢 pymodbus-class',
  describe:
    'Exception-code verdicts, gateway-vs-slave isolation. Register/coil read; ARM-gated single writes.',
  verbs: ['connect', 'identify', 'browse', 'read', 'write', 'monitor', 'diagnose'],
  params: {
    connect: { unit_id: { type: 'number', default: 1, min: 0, max: 247 } },
    browse: {
      // Interpret the first block of each register area with a chosen width /
      // byte order (bit areas ignore it).
      format: { type: 'enum', options: ['uint16', 'int16', 'uint32', 'int32', 'float32', 'uint64', 'int64', 'float64'], default: 'uint16' },
      byte_order: { type: 'enum', options: ['ABCD', 'CDAB', 'BADC', 'DCBA'], default: 'ABCD' },
    },
    read: {
      area: { type: 'enum', options: ['holding', 'input', 'coils', 'discrete'], default: 'holding' },
      address: { type: 'number', default: 0, min: 0, max: 65535 },
      count: { type: 'number', default: 8, min: 1, max: 125 },
      // Interpret register runs as wider types (the constant field question:
      // "is this a float, and in which byte order?"). 32-bit types consume two
      // registers, 64-bit types four; byte_order handles every Modbus quirk of
      // word- and byte-swapping: ABCD (big), CDAB (word-swap), BADC (byte-swap),
      // DCBA (little). Legacy big/little map to ABCD/CDAB.
      format: { type: 'enum', options: ['uint16', 'int16', 'uint32', 'int32', 'float32', 'uint64', 'int64', 'float64'], default: 'uint16' },
      byte_order: { type: 'enum', options: ['ABCD', 'CDAB', 'BADC', 'DCBA'], default: 'ABCD' },
    },
    write: {
      area: { type: 'enum', options: ['holding', 'coil'], default: 'holding' },
      address: { type: 'number', default: 0, min: 0, max: 65535 },
      value: { type: 'number', default: 0 },
      // Wide formats encode `value` into 2 (32-bit) or 4 (64-bit) registers and
      // write them with FC16 (Write Multiple Registers) — e.g. a float setpoint.
      // byte_order must match the device (ABCD/CDAB/BADC/DCBA).
      format: { type: 'enum', options: ['uint16', 'int16', 'uint32', 'int32', 'float32', 'uint64', 'int64', 'float64'], default: 'uint16' },
      byte_order: { type: 'enum', options: ['ABCD', 'CDAB', 'BADC', 'DCBA'], default: 'ABCD' },
    },
  },
};

const FC = {
  READ_COILS: 0x01,
  READ_DISCRETE: 0x02,
  READ_HOLDING: 0x03,
  READ_INPUT: 0x04,
  WRITE_COIL: 0x05,
  WRITE_REGISTER: 0x06,
  WRITE_MULTIPLE: 0x10,
};

const EXCEPTION_TEXT = {
  0x01: 'Illegal Function',
  0x02: 'Illegal Data Address',
  0x03: 'Illegal Data Value',
  0x04: 'Slave Device Failure',
  0x05: 'Acknowledge',
  0x06: 'Slave Device Busy',
  0x08: 'Memory Parity Error',
  0x0a: 'Gateway Path Unavailable',
  0x0b: 'Gateway Target Device Failed To Respond',
};

let txid = 0;
function nextTid() {
  txid = (txid + 1) & 0xffff;
  return txid;
}

// Build a MBAP-framed request. pdu = Buffer of [function, ...data].
function frame(unitId, pdu) {
  const tid = nextTid();
  const header = Buffer.alloc(7);
  header.writeUInt16BE(tid, 0); // transaction id
  header.writeUInt16BE(0, 2); // protocol id (0 = Modbus)
  header.writeUInt16BE(pdu.length + 1, 4); // length: unit + pdu
  header.writeUInt8(unitId & 0xff, 6); // unit id
  return { tid, buf: Buffer.concat([header, pdu]) };
}

// A complete MBAP response has 6-byte header declaring the remaining length.
function isComplete(buf) {
  if (buf.length < 6) return false;
  const len = buf.readUInt16BE(4);
  return buf.length >= 6 + len;
}

function parseResponse(buf, expectedFc) {
  if (buf.length < 8) return { error: 'short-frame', raw: buf };
  const tid = buf.readUInt16BE(0);
  const unit = buf.readUInt8(6);
  const fc = buf.readUInt8(7);
  const isException = (fc & 0x80) !== 0;
  if (isException) {
    const code = buf.length > 8 ? buf.readUInt8(8) : null;
    return {
      tid,
      unit,
      exception: true,
      exception_code: code,
      exception_text: EXCEPTION_TEXT[code] || `Unknown (0x${(code ?? 0).toString(16)})`,
      function_code: fc & 0x7f,
      raw: buf,
    };
  }
  return {
    tid,
    unit,
    exception: false,
    function_code: fc,
    function_code_echoed: fc === expectedFc,
    data: buf.subarray(8),
    raw: buf,
  };
}

async function transact(host, port, unitId, pdu, timeout) {
  const { socket, connectMs } = await tcpConnect(host, port, timeout);
  try {
    const { buf } = frame(unitId, pdu);
    const { data, rttMs } = await tcpRequest(socket, buf, { timeout, isComplete });
    return { request: buf, response: data, connectMs, rttMs };
  } finally {
    socket.destroy();
  }
}

const AREA_FC = {
  holding: FC.READ_HOLDING,
  input: FC.READ_INPUT,
  coils: FC.READ_COILS,
  discrete: FC.READ_DISCRETE,
};

function readPdu(area, address, count) {
  const fc = AREA_FC[area] ?? FC.READ_HOLDING;
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(fc, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(count, 3);
  return { fc, pdu };
}

const round = (n) => Math.round(n * 1000) / 1000;

// The four byte/word orderings Modbus devices disagree on, named by where the
// most-significant→least-significant bytes A,B,C,D land on the wire (Modbus
// registers are big-endian, so word 0 carries bytes A,B):
//   ABCD  big-endian            (high word first, big bytes)   — legacy 'big'
//   CDAB  word-swapped          (low word first, big bytes)    — legacy 'little'
//   BADC  byte-swapped          (high word first, swapped bytes)
//   DCBA  little-endian         (low word first, swapped bytes)
// For 64-bit values the same names generalize across four registers (word swap =
// reverse word order; byte swap = swap the two bytes inside every word).
export const BYTE_ORDERS = ['ABCD', 'CDAB', 'BADC', 'DCBA'];

// Registers consumed per value.
const WIDTH = { uint16: 1, int16: 1, uint32: 2, int32: 2, float32: 2, uint64: 4, int64: 4, float64: 4 };
export function registerStride(format) { return WIDTH[format] || 1; }

// Legacy word_order 'big'/'little' → canonical byte-order names.
function canonOrder(order) {
  if (order === 'big') return 'ABCD';
  if (order === 'little') return 'CDAB';
  return BYTE_ORDERS.includes(order) ? order : 'ABCD';
}

// Resolve the byte ordering from params: byte_order wins, legacy word_order is
// accepted, default ABCD (big-endian).
function orderOf(ctx) {
  return canonOrder(ctx.params?.byte_order ?? ctx.params?.word_order ?? 'ABCD');
}

// Coerce a 64-bit integer input (BigInt, integer string, or Number) to BigInt
// without the precision loss of routing large values through Number.
function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') return BigInt(value.trim().split('.')[0] || '0');
  return BigInt(Math.trunc(Number(value)));
}

// Permute wire bytes (big-endian register concatenation) ↔ a normalized
// big-endian buffer, per the ordering. Each ordering is its own inverse, so the
// same function serves decode (wire→normalized) and encode (normalized→wire).
function permuteBytes(src, order) {
  const words = src.length / 2;
  const out = Buffer.alloc(src.length);
  for (let w = 0; w < words; w++) {
    const hi = src[w * 2];
    const lo = src[w * 2 + 1];
    const swapBytes = order === 'BADC' || order === 'DCBA';
    const swapWords = order === 'CDAB' || order === 'DCBA';
    const dstWord = swapWords ? words - 1 - w : w;
    out[dstWord * 2] = swapBytes ? lo : hi;
    out[dstWord * 2 + 1] = swapBytes ? hi : lo;
  }
  return out;
}

// Render a decoded read as an address → value table (the UI draws any `tree`).
// Wide formats stride multiple registers per value.
function valueTree(area, address, decoded, format) {
  const isBits = area === 'coils' || area === 'discrete';
  const stride = registerStride(format);
  const type = isBits ? 'bool' : format;
  return [{
    area: `${area} @${address}${!isBits && format !== 'uint16' ? ` · ${format}` : ''} · ${decoded.values.length} value(s)`,
    points: decoded.values.map((v, i) => ({ ref: `${area}:${address + i * stride}`, value: v, type })),
  }];
}

// Reinterpret a raw uint16 register array as wider numeric types, honoring the
// device's byte/word ordering (ABCD/CDAB/BADC/DCBA, or legacy big/little).
// 32-bit types combine register pairs; 64-bit types combine four registers.
export function interpretRegisters(regs, format = 'uint16', order = 'ABCD') {
  order = canonOrder(order);
  if (format === 'uint16') return regs.slice();
  if (format === 'int16') return regs.map((r) => (r & 0x8000 ? r - 0x10000 : r));
  const stride = registerStride(format);
  const out = [];
  for (let i = 0; i + stride <= regs.length; i += stride) {
    const wire = Buffer.alloc(stride * 2);
    for (let w = 0; w < stride; w++) wire.writeUInt16BE(regs[i + w] & 0xffff, w * 2);
    const b = permuteBytes(wire, order);
    if (format === 'uint32') out.push(b.readUInt32BE(0));
    else if (format === 'int32') out.push(b.readInt32BE(0));
    else if (format === 'float32') out.push(round(b.readFloatBE(0)));
    else if (format === 'float64') out.push(round(b.readDoubleBE(0)));
    else if (format === 'uint64') { const v = b.readBigUInt64BE(0); out.push(v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()); }
    else if (format === 'int64') { const v = b.readBigInt64BE(0); out.push(v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()); }
  }
  return out;
}

// Encode a value into the uint16 registers that carry it, ordered per the same
// byte/word ordering. Inverse of interpretRegisters (permuteBytes is symmetric).
export function encodeRegisters(value, format = 'uint16', order = 'ABCD') {
  order = canonOrder(order);
  if (format === 'uint16' || format === 'int16') return [value & 0xffff];
  const stride = registerStride(format);
  const b = Buffer.alloc(stride * 2);
  if (format === 'float32') b.writeFloatBE(value, 0);
  else if (format === 'int32') b.writeInt32BE(value | 0, 0);
  else if (format === 'uint32') b.writeUInt32BE(value >>> 0, 0);
  else if (format === 'float64') b.writeDoubleBE(value, 0);
  else if (format === 'int64') b.writeBigInt64BE(BigInt.asIntN(64, toBigInt(value)), 0);
  else if (format === 'uint64') b.writeBigUInt64BE(BigInt.asUintN(64, toBigInt(value)), 0);
  const wire = permuteBytes(b, order);
  const regs = [];
  for (let w = 0; w < stride; w++) regs.push(wire.readUInt16BE(w * 2));
  return regs;
}

// FC16 Write Multiple Registers PDU.
function writeMultiplePdu(address, regs) {
  const pdu = Buffer.alloc(6 + regs.length * 2);
  pdu.writeUInt8(FC.WRITE_MULTIPLE, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(regs.length, 3);
  pdu.writeUInt8(regs.length * 2, 5);
  regs.forEach((r, i) => pdu.writeUInt16BE(r & 0xffff, 6 + i * 2));
  return pdu;
}

function decodeReadResponse(area, parsed, count, format = 'uint16', order = 'ABCD') {
  if (parsed.exception || !parsed.data) return null;
  const body = parsed.data;
  const byteCount = body.readUInt8(0);
  const payload = body.subarray(1, 1 + byteCount);
  if (area === 'coils' || area === 'discrete') {
    const bits = [];
    for (let i = 0; i < count; i++) {
      const byte = payload[Math.floor(i / 8)] ?? 0;
      bits.push((byte >> i % 8) & 1);
    }
    return { type: 'bits', values: bits };
  }
  const regs = [];
  for (let i = 0; i + 1 < payload.length; i += 2) regs.push(payload.readUInt16BE(i));
  return { type: 'registers', registers: regs, values: interpretRegisters(regs, format, order), format, byte_order: canonOrder(order) };
}

async function doRead(ctx, area, address, count, format = 'uint16', order = 'ABCD') {
  const timeout = ctx.params?.timeout ?? 3000;
  const { fc, pdu } = readPdu(area, address, count);
  const { request, response, connectMs, rttMs } = await transact(
    ctx.host,
    ctx.port || 502,
    ctx.unitId ?? 1,
    pdu,
    timeout,
  );
  const parsed = parseResponse(response, fc);
  const decoded = decodeReadResponse(area, parsed, count, format, order);
  return { request, response, parsed, decoded, connectMs, rttMs, area, address, count };
}

// Facts for the modbus rulepack (§5).
function readFacts(r, tcpOk = true) {
  return {
    transport: { tcp_connect: tcpOk ? 'success' : 'fail' },
    response: {
      exception_code: r.parsed?.exception ? r.parsed.exception_code : 'none',
      function_code_echoed: r.parsed?.function_code_echoed || false,
    },
    timeout: false,
    rtt_ms: r.rttMs,
  };
}

export const verbs = {
  async connect(ctx) {
    const timeout = ctx.params?.timeout ?? 3000;
    try {
      const { socket, connectMs } = await tcpConnect(ctx.host, ctx.port || 502, timeout);
      socket.destroy();
      return {
        artifact: makeArtifact({
          verb: 'connect',
          raw: `TCP ${ctx.host}:${ctx.port || 502} open (${connectMs.toFixed(1)}ms), unit ${ctx.unitId ?? 1}`,
          result: { connected: true, connect_ms: connectMs, unit_id: ctx.unitId ?? 1 },
        }),
        facts: { transport: { tcp_connect: 'success' } },
      };
    } catch (err) {
      return {
        artifact: makeArtifact({
          verb: 'connect',
          raw: `TCP ${ctx.host}:${ctx.port || 502} failed: ${err.code || err.message}`,
          result: { connected: false, error: err.code || err.message },
          error: err,
        }),
        facts: { transport: { tcp_connect: 'fail', error: err.code } },
      };
    }
  },

  // Identify probes a single holding register; a valid echo (or a *Modbus*
  // exception) both prove a live Modbus stack behind the port.
  async identify(ctx) {
    try {
      const r = await doRead(ctx, 'holding', 0, 1);
      const alive = !r.parsed.error;
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: bytesRaw(r.request, r.response),
          decode: r.parsed,
          result: {
            modbus_responding: alive,
            unit_id: ctx.unitId ?? 1,
            exception: r.parsed.exception ? r.parsed.exception_text : null,
            rtt_ms: r.rttMs,
          },
        }),
        facts: readFacts(r),
      };
    } catch (err) {
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: `error: ${err.code || err.message}`,
          result: { modbus_responding: false, error: err.code || err.message },
          error: err,
        }),
        facts: { transport: { tcp_connect: err.code === 'ETIMEDOUT' ? 'success' : 'fail' }, timeout: err.code === 'ETIMEDOUT' },
      };
    }
  },

  // Browse builds a small PointTree by reading the first block of each area.
  // Register areas honor an optional format/byte_order so the point table
  // reflects the actual interpretation (e.g. browse holding as float32); bit
  // areas ignore it. Wide types stride multiple registers per point.
  async browse(ctx) {
    const areas = ['holding', 'input', 'coils', 'discrete'];
    const format = ctx.params?.format ?? 'uint16';
    const order = orderOf(ctx);
    const stride = registerStride(format);
    const tree = [];
    for (const area of areas) {
      const isBits = area === 'coils' || area === 'discrete';
      try {
        const r = await doRead(ctx, area, 0, 8, isBits ? 'uint16' : format, order);
        if (r.decoded) {
          tree.push({
            area,
            points: r.decoded.values.map((v, i) => {
              const addr = isBits ? i : i * stride;
              return { ref: `${area}:${addr}`, address: addr, value: v, type: r.decoded.type === 'bits' ? 'bool' : format };
            }),
          });
        } else if (r.parsed.exception) {
          tree.push({ area, error: r.parsed.exception_text });
        }
      } catch (err) {
        tree.push({ area, error: err.code || err.message });
      }
    }
    return {
      artifact: makeArtifact({
        verb: 'browse',
        result: { tree },
        raw: `browsed ${tree.length} areas`,
      }),
      facts: {},
    };
  },

  async read(ctx) {
    const area = ctx.params?.area ?? 'holding';
    const address = ctx.params?.address ?? 0;
    const count = ctx.params?.count ?? 8;
    const format = ctx.params?.format ?? 'uint16';
    const order = orderOf(ctx);
    try {
      const r = await doRead(ctx, area, address, count, format, order);
      const isReg = r.decoded?.type === 'registers';
      const wide = registerStride(format) > 1;
      return {
        artifact: makeArtifact({
          verb: 'read',
          raw: bytesRaw(r.request, r.response),
          decode: r.parsed,
          result: {
            area,
            address,
            count,
            format: isReg ? format : undefined,
            byte_order: isReg && wide ? order : undefined,
            values: r.decoded ? r.decoded.values : null,
            registers: isReg && format !== 'uint16' ? r.decoded.registers : undefined,
            tree: r.decoded ? valueTree(area, address, r.decoded, format) : undefined,
            exception: r.parsed.exception ? r.parsed.exception_text : null,
            rtt_ms: r.rttMs,
          },
        }),
        facts: readFacts(r),
      };
    } catch (err) {
      return {
        artifact: makeArtifact({ verb: 'read', raw: `error: ${err.code || err.message}`, error: err }),
        facts: { transport: { tcp_connect: err.code === 'ETIMEDOUT' ? 'success' : 'fail' }, timeout: err.code === 'ETIMEDOUT' },
      };
    }
  },

  // Gate-2 preview: read the target's current value (with the right width and
  // interpretation) so the confirm shows current → proposed accurately.
  async previewWrite(ctx) {
    const area = ctx.params?.area ?? 'holding';
    const address = ctx.params?.address ?? 0;
    const value = ctx.params?.value ?? 0;
    const format = ctx.params?.format ?? 'uint16';
    const order = orderOf(ctx);
    const stride = area === 'coil' ? 1 : registerStride(format);
    let current = null;
    try {
      const rb = await doRead(ctx, area === 'coil' ? 'coils' : 'holding', address, stride, format, order);
      current = rb.decoded ? rb.decoded.values[0] : null;
    } catch { /* current unknown */ }
    return {
      point: `${area}:${address}${format !== 'uint16' && area !== 'coil' ? ` (${format})` : ''}`,
      current_value: current,
      proposed_value: value,
      target: ctx.port ? `${ctx.host}:${ctx.port}` : ctx.host,
    };
  },

  // Write is gated. The orchestrator only calls this after ARM + per-write
  // confirm; the driver still refuses to compose the frame if not armed, so the
  // write path cannot fire silently even by mistake.
  async write(ctx) {
    if (!ctx.armed) {
      throw new Error('write refused: session not ARMED (double-gate, §4.1)');
    }
    const area = ctx.params?.area ?? 'holding';
    const address = ctx.params?.address ?? 0;
    const value = ctx.params?.value ?? 0;
    const format = ctx.params?.format ?? 'uint16';
    const order = orderOf(ctx);
    const timeout = ctx.params?.timeout ?? 3000;
    const stride = area === 'coil' ? 1 : registerStride(format);
    const wide = area !== 'coil' && stride > 1;

    let pdu;
    let expectedFc;
    if (area === 'coil') {
      pdu = Buffer.alloc(5);
      pdu.writeUInt8(FC.WRITE_COIL, 0);
      pdu.writeUInt16BE(address, 1);
      pdu.writeUInt16BE(value ? 0xff00 : 0x0000, 3);
      expectedFc = FC.WRITE_COIL;
    } else if (wide) {
      // Wide value → two (32-bit) or four (64-bit) registers via FC16.
      pdu = writeMultiplePdu(address, encodeRegisters(value, format, order));
      expectedFc = FC.WRITE_MULTIPLE;
    } else {
      pdu = Buffer.alloc(5);
      pdu.writeUInt8(FC.WRITE_REGISTER, 0);
      pdu.writeUInt16BE(address, 1);
      pdu.writeUInt16BE(value & 0xffff, 3);
      expectedFc = FC.WRITE_REGISTER;
    }
    const { request, response, rttMs } = await transact(
      ctx.host,
      ctx.port || 502,
      ctx.unitId ?? 1,
      pdu,
      timeout,
    );
    const parsed = parseResponse(response, expectedFc);
    const ok = !parsed.exception && parsed.function_code_echoed;

    // Read-back verification (§4.1) so the artifact reports whether it took.
    let readBack = null;
    try {
      const rb = await doRead(ctx, area === 'coil' ? 'coils' : 'holding', address, stride, format, order);
      readBack = rb.decoded ? rb.decoded.values[0] : null;
    } catch {
      readBack = null;
    }
    const expected = area === 'coil' ? (value ? 1 : 0) : value;
    const isFloat = format === 'float32' || format === 'float64';
    const verified = readBack == null ? null
      : isFloat ? Math.abs(Number(readBack) - Number(expected)) < 0.01
      : Number(readBack) === Number(expected);

    return {
      artifact: makeArtifact({
        verb: 'write',
        raw: bytesRaw(request, response),
        decode: parsed,
        result: {
          area,
          address,
          format: area !== 'coil' ? format : undefined,
          written: value,
          ack: ok,
          exception: parsed.exception ? parsed.exception_text : null,
          read_back: readBack,
          verified,
          rtt_ms: rttMs,
        },
      }),
      facts: { write_ack: ok },
      audit: { action: 'modbus-write', target: `${ctx.host}:${ctx.port || 502}`, point: `${area}:${address}`, after_value: value, before_value: ctx.beforeValue ?? null },
    };
  },

  async monitorSample(ctx) {
    const area = ctx.params?.area ?? 'holding';
    const address = ctx.params?.address ?? 0;
    try {
      const r = await doRead(ctx, area, address, 1);
      const value = r.decoded ? r.decoded.values[0] : null;
      return { value: r.rttMs, series: { register: value }, ok: !r.parsed.exception, raw: bytesRaw(r.request, r.response) };
    } catch (err) {
      return { value: null, ok: false, raw: `error: ${err.code || err.message}` };
    }
  },

  async diagnose(ctx) {
    try {
      const r = await doRead(ctx, ctx.params?.area ?? 'holding', ctx.params?.address ?? 0, ctx.params?.count ?? 1);
      return { facts: readFacts(r), rulepack: 'modbus-tcp', raw: bytesRaw(r.request, r.response), decode: r.parsed };
    } catch (err) {
      const timeout = err.code === 'ETIMEDOUT';
      return {
        facts: { transport: { tcp_connect: timeout ? 'success' : 'fail' }, response: 'none', timeout },
        rulepack: 'modbus-tcp',
        raw: `error: ${err.code || err.message}`,
      };
    }
  },
};

function bytesRaw(req, res) {
  return {
    tx: req ? Buffer.from(req).toString('hex') : null,
    rx: res ? Buffer.from(res).toString('hex') : null,
  };
}
