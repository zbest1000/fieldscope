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
    read: {
      area: { type: 'enum', options: ['holding', 'input', 'coils', 'discrete'], default: 'holding' },
      address: { type: 'number', default: 0, min: 0, max: 65535 },
      count: { type: 'number', default: 8, min: 1, max: 125 },
    },
    write: {
      area: { type: 'enum', options: ['holding', 'coil'], default: 'holding' },
      address: { type: 'number', default: 0, min: 0, max: 65535 },
      value: { type: 'number', default: 0 },
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

function decodeReadResponse(area, parsed, count) {
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
  return { type: 'registers', values: regs };
}

async function doRead(ctx, area, address, count) {
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
  const decoded = decodeReadResponse(area, parsed, count);
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
  async browse(ctx) {
    const areas = ['holding', 'input', 'coils', 'discrete'];
    const tree = [];
    for (const area of areas) {
      try {
        const r = await doRead(ctx, area, 0, 8);
        if (r.decoded) {
          tree.push({
            area,
            points: r.decoded.values.map((v, i) => ({
              ref: `${area}:${i}`,
              address: i,
              value: v,
              type: r.decoded.type === 'bits' ? 'bool' : 'uint16',
            })),
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
    try {
      const r = await doRead(ctx, area, address, count);
      return {
        artifact: makeArtifact({
          verb: 'read',
          raw: bytesRaw(r.request, r.response),
          decode: r.parsed,
          result: {
            area,
            address,
            count,
            values: r.decoded ? r.decoded.values : null,
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
    const timeout = ctx.params?.timeout ?? 3000;

    const pdu = Buffer.alloc(5);
    if (area === 'coil') {
      pdu.writeUInt8(FC.WRITE_COIL, 0);
      pdu.writeUInt16BE(address, 1);
      pdu.writeUInt16BE(value ? 0xff00 : 0x0000, 3);
    } else {
      pdu.writeUInt8(FC.WRITE_REGISTER, 0);
      pdu.writeUInt16BE(address, 1);
      pdu.writeUInt16BE(value & 0xffff, 3);
    }
    const expectedFc = area === 'coil' ? FC.WRITE_COIL : FC.WRITE_REGISTER;
    const { request, response, rttMs } = await transact(
      ctx.host,
      ctx.port || 502,
      ctx.unitId ?? 1,
      pdu,
      timeout,
    );
    const parsed = parseResponse(response, expectedFc);
    const ok = !parsed.exception && parsed.function_code_echoed;

    // Dry-run / preview is handled by the orchestrator before ARM; here we do a
    // read-back verification (§4.1) so the artifact reports whether it took.
    let readBack = null;
    try {
      const rb = await doRead(
        { ...ctx, params: { ...ctx.params } },
        area === 'coil' ? 'coils' : 'holding',
        address,
        1,
      );
      readBack = rb.decoded ? rb.decoded.values[0] : null;
    } catch {
      readBack = null;
    }

    return {
      artifact: makeArtifact({
        verb: 'write',
        raw: bytesRaw(request, response),
        decode: parsed,
        result: {
          area,
          address,
          written: value,
          ack: ok,
          exception: parsed.exception ? parsed.exception_text : null,
          read_back: readBack,
          verified: readBack != null ? Number(readBack) === Number(area === 'coil' ? (value ? 1 : 0) : value) : null,
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
