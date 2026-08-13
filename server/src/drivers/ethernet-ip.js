// EtherNet/IP + CIP driver (§6.2, §12 phase 3). The second-highest-demand
// industrial protocol, and a very different shape from Modbus: little-endian
// encapsulation framing, session registration, and a rich Identity object whose
// status word + state byte carry the diagnostic story (ownership, configuration,
// minor/major faults).
//
// Implemented raw over TCP 44818 — ListIdentity and RegisterSession are simple
// encapsulation commands, which keeps the driver dependency-free while
// producing real bytes for the Raw tab and real status-word verdicts.

import { tcpConnect, tcpRequest } from '../transport/transport.js';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'ethernet-ip',
  display_name: 'EtherNet/IP + CIP',
  domain: 'industrial',
  group: 'industrial',
  transport: ['tcp'],
  default_port: 44818,
  catalog_formats: ['eds'],
  mode: 'full',
  lib: '🟢 raw encapsulation',
  describe:
    'Identity object decode: vendor/product/revision/serial, status-word fault bits, device state. Session registration check.',
  verbs: ['connect', 'identify', 'monitor', 'diagnose'],
};

// Encapsulation commands (CIP Vol 2, ch. 2).
const CMD = {
  LIST_SERVICES: 0x0004,
  LIST_IDENTITY: 0x0063,
  REGISTER_SESSION: 0x0065,
  UNREGISTER_SESSION: 0x0066,
};

const ENCAP_STATUS_TEXT = {
  0x0000: 'success',
  0x0001: 'invalid or unsupported command',
  0x0002: 'insufficient memory',
  0x0003: 'malformed data',
  0x0064: 'invalid session handle',
  0x0065: 'invalid length',
  0x0069: 'unsupported protocol version',
};

// CIP Identity object state attribute.
const STATE_TEXT = {
  0: 'Nonexistent',
  1: 'Device Self Testing',
  2: 'Standby',
  3: 'Operational',
  4: 'Major Recoverable Fault',
  5: 'Major Unrecoverable Fault',
  255: 'Default (not reported)',
};

// ODVA device type codes (partial — the common ones).
const DEVICE_TYPE_TEXT = {
  0x00: 'Generic Device',
  0x02: 'AC Drive',
  0x03: 'Motor Overload',
  0x04: 'Limit Switch',
  0x07: 'General Purpose Discrete I/O',
  0x0c: 'Communications Adapter',
  0x0e: 'Programmable Logic Controller',
  0x10: 'Position Controller',
  0x13: 'DC Drive',
  0x18: 'Human-Machine Interface',
  0x25: 'CIP Motion Drive',
  0x2b: 'Generic Device (keyable)',
};

// ODVA vendor IDs (partial — enough to name the majors; unknown IDs render numerically).
const VENDOR_TEXT = {
  1: 'Rockwell Automation / Allen-Bradley',
  26: 'Festo',
  47: 'Omron',
  90: 'HMS Networks',
  108: 'Beckhoff Automation',
  252: 'WAGO',
  283: 'Molex / HMS',
  678: 'Turck',
  808: 'SICK',
  1105: 'Phoenix Contact',
};

// 24-byte encapsulation header, little-endian throughout.
function encapFrame(command, data = Buffer.alloc(0), sessionHandle = 0) {
  const header = Buffer.alloc(24);
  header.writeUInt16LE(command, 0);
  header.writeUInt16LE(data.length, 2);
  header.writeUInt32LE(sessionHandle, 4);
  header.writeUInt32LE(0, 8); // status
  header.write('FIELDSCP', 12, 8, 'latin1'); // sender context (echoed back)
  header.writeUInt32LE(0, 20); // options
  return Buffer.concat([header, data]);
}

function encapComplete(buf) {
  if (buf.length < 24) return false;
  const len = buf.readUInt16LE(2);
  return buf.length >= 24 + len;
}

function parseEncapHeader(buf) {
  if (buf.length < 24) return { error: 'short-frame' };
  return {
    command: buf.readUInt16LE(0),
    length: buf.readUInt16LE(2),
    session_handle: buf.readUInt32LE(4),
    status: buf.readUInt32LE(8),
    status_text: ENCAP_STATUS_TEXT[buf.readUInt32LE(8)] || `0x${buf.readUInt32LE(8).toString(16)}`,
    data: buf.subarray(24, 24 + buf.readUInt16LE(2)),
  };
}

// ListIdentity response data: item count, then CPF items; item type 0x0C is the
// Identity item (CIP Vol 2, 2-4.3.2).
function parseIdentity(data) {
  if (data.length < 2) return null;
  const itemCount = data.readUInt16LE(0);
  let off = 2;
  for (let i = 0; i < itemCount; i++) {
    if (off + 4 > data.length) break;
    const type = data.readUInt16LE(off);
    const len = data.readUInt16LE(off + 2);
    const body = data.subarray(off + 4, off + 4 + len);
    off += 4 + len;
    if (type !== 0x000c || body.length < 33) continue;

    const status = body.readUInt16LE(24);
    const nameLen = body.readUInt8(32);
    const vendorId = body.readUInt16LE(18);
    const deviceType = body.readUInt16LE(20);
    return {
      encap_protocol_version: body.readUInt16LE(0),
      // sockaddr (big-endian by spec): family(2) port(2) addr(4) zero(8)
      sockaddr: {
        port: body.readUInt16BE(4),
        address: [...body.subarray(6, 10)].join('.'),
      },
      vendor_id: vendorId,
      vendor_name: VENDOR_TEXT[vendorId] || `vendor ${vendorId}`,
      device_type: deviceType,
      device_type_name: DEVICE_TYPE_TEXT[deviceType] || `type 0x${deviceType.toString(16)}`,
      product_code: body.readUInt16LE(22),
      revision: `${body.readUInt8(26)}.${body.readUInt8(27)}`,
      status,
      status_bits: decodeStatus(status),
      serial_number: body.readUInt32LE(28).toString(16).padStart(8, '0'),
      product_name: body.subarray(33, 33 + nameLen).toString('latin1'),
      state: body.length > 33 + nameLen ? body.readUInt8(33 + nameLen) : null,
      state_text:
        body.length > 33 + nameLen
          ? STATE_TEXT[body.readUInt8(33 + nameLen)] || `state ${body.readUInt8(33 + nameLen)}`
          : null,
    };
  }
  return null;
}

// CIP Identity status word (attribute 5) — the diagnostic payload.
function decodeStatus(status) {
  return {
    owned: !!(status & 0x0001),
    configured: !!(status & 0x0004),
    extended_status: (status >> 4) & 0x0f,
    minor_recoverable_fault: !!(status & 0x0100),
    minor_unrecoverable_fault: !!(status & 0x0200),
    major_recoverable_fault: !!(status & 0x0400),
    major_unrecoverable_fault: !!(status & 0x0800),
  };
}

async function transact(host, port, request, timeout) {
  const { socket, connectMs } = await tcpConnect(host, port, timeout);
  try {
    const { data, rttMs } = await tcpRequest(socket, request, { timeout, isComplete: encapComplete });
    return { response: data, connectMs, rttMs };
  } finally {
    socket.destroy();
  }
}

async function listIdentity(ctx) {
  const timeout = ctx.params?.timeout ?? 3000;
  const request = encapFrame(CMD.LIST_IDENTITY);
  const { response, connectMs, rttMs } = await transact(ctx.host, ctx.port || 44818, request, timeout);
  const header = parseEncapHeader(response);
  const identity = header.error || header.status !== 0 ? null : parseIdentity(header.data);
  return { request, response, header, identity, connectMs, rttMs };
}

function bytesRaw(req, res) {
  return {
    tx: req ? Buffer.from(req).toString('hex') : null,
    rx: res ? Buffer.from(res).toString('hex') : null,
  };
}

function identityFacts(r) {
  const id = r.identity;
  return {
    transport: { tcp_connect: 'success' },
    encap: { status: r.header.status, status_text: r.header.status_text },
    identity: id
      ? {
          received: true,
          state: id.state,
          state_text: id.state_text,
          owned: id.status_bits.owned,
          configured: id.status_bits.configured,
          minor_fault:
            id.status_bits.minor_recoverable_fault || id.status_bits.minor_unrecoverable_fault,
          major_recoverable_fault: id.status_bits.major_recoverable_fault,
          major_unrecoverable_fault: id.status_bits.major_unrecoverable_fault,
        }
      : { received: false },
    timeout: false,
    rtt_ms: r.rttMs,
  };
}

function errorFacts(err) {
  const timeout = err.code === 'ETIMEDOUT';
  return {
    transport: { tcp_connect: timeout ? 'success' : 'fail', error: err.code || err.message },
    identity: { received: false },
    timeout,
  };
}

export const verbs = {
  // Connect = TCP + RegisterSession: proves a live encapsulation stack and
  // reports the negotiated protocol version + assigned session handle.
  async connect(ctx) {
    const timeout = ctx.params?.timeout ?? 3000;
    const data = Buffer.alloc(4);
    data.writeUInt16LE(1, 0); // requested protocol version
    data.writeUInt16LE(0, 2); // options
    const request = encapFrame(CMD.REGISTER_SESSION, data);
    try {
      const { response, connectMs, rttMs } = await transact(ctx.host, ctx.port || 44818, request, timeout);
      const header = parseEncapHeader(response);
      const ok = !header.error && header.status === 0 && header.session_handle !== 0;
      return {
        artifact: makeArtifact({
          verb: 'connect',
          raw: bytesRaw(request, response),
          decode: header.error ? header : { ...header, data: undefined },
          result: {
            registered: ok,
            session_handle: ok ? `0x${header.session_handle.toString(16)}` : null,
            encap_status: header.status_text,
            connect_ms: connectMs,
            rtt_ms: rttMs,
          },
        }),
        facts: { transport: { tcp_connect: 'success' }, session_registered: ok },
      };
    } catch (err) {
      return {
        artifact: makeArtifact({
          verb: 'connect',
          raw: `error: ${err.code || err.message}`,
          result: { registered: false, error: err.code || err.message },
          error: err,
        }),
        facts: errorFacts(err),
      };
    }
  },

  // Identify = ListIdentity: the CIP Identity object, decoded. Vendor, device
  // type, revision, serial, and the status word + state that Diagnose reads.
  async identify(ctx) {
    try {
      const r = await listIdentity(ctx);
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: bytesRaw(r.request, r.response),
          decode: r.identity,
          result: r.identity
            ? {
                product_name: r.identity.product_name,
                vendor: r.identity.vendor_name,
                device_type: r.identity.device_type_name,
                revision: r.identity.revision,
                serial_number: r.identity.serial_number,
                state: r.identity.state_text,
                status_bits: r.identity.status_bits,
                rtt_ms: r.rttMs,
              }
            : { identity: null, encap_status: r.header.status_text },
        }),
        facts: identityFacts(r),
      };
    } catch (err) {
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: `error: ${err.code || err.message}`,
          result: { identity: null, error: err.code || err.message },
          error: err,
        }),
        facts: errorFacts(err),
      };
    }
  },

  async monitorSample(ctx) {
    try {
      const r = await listIdentity(ctx);
      return {
        value: r.rttMs,
        ok: !!r.identity,
        series: { state: r.identity ? r.identity.state : null },
        raw: bytesRaw(r.request, r.response),
      };
    } catch (err) {
      return { value: null, ok: false, raw: `error: ${err.code || err.message}` };
    }
  },

  async diagnose(ctx) {
    try {
      const r = await listIdentity(ctx);
      return {
        facts: identityFacts(r),
        rulepack: 'ethernet-ip',
        raw: bytesRaw(r.request, r.response),
        decode: r.identity,
      };
    } catch (err) {
      return { facts: errorFacts(err), rulepack: 'ethernet-ip', raw: `error: ${err.code || err.message}` };
    }
  },
};
