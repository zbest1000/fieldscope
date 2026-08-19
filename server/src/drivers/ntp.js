// NTP / SNTP driver (§6.1 IT tier). Clock synchronisation is first-class in OT —
// the evidence store anchors every artifact's timestamp to a clock source
// (`clock_anchor`), event-tagged SCADA points (CP56Time2a, Sparkplug) are only
// as trustworthy as the device clock, and a drifted clock silently corrupts
// sequence-of-events analysis. Yet "is this server actually serving good time?"
// is rarely checked in the field.
//
// This driver speaks SNTP (RFC 4330) directly: a single 48-byte UDP exchange
// that returns the server's stratum, leap indicator, root dispersion, reference
// source, and — by comparing the four timestamps — the local clock offset and
// round-trip delay. Dependency-free; no system clock is changed (read-only).

import { udpRequest } from '../transport/transport.js';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'ntp',
  display_name: 'NTP / SNTP',
  domain: 'it',
  group: 'tools',
  transport: ['udp'],
  default_port: 123,
  mode: 'full',
  lib: '🟢 raw SNTP (RFC 4330)',
  describe:
    'Time-server health: stratum, leap indicator, root dispersion, reference source, and the measured local clock offset / round-trip delay.',
  verbs: ['identify', 'monitor', 'diagnose'],
  params: {
    identify: { timeout: { type: 'number', min: 200, max: 15000, default: 3000 } },
    monitor: { cadence: { type: 'number', min: 250, max: 60000, default: 2000 } },
  },
};

const NTP_UNIX_EPOCH_DELTA = 2208988800; // seconds between 1900-01-01 and 1970-01-01
const LEAP_TEXT = ['no-warning', 'last-minute-61s', 'last-minute-59s', 'unsynchronized'];

// Write a JS epoch-ms as an NTP 64-bit timestamp (32-bit seconds + 32-bit frac).
function writeNtpTimestamp(buf, off, ms) {
  const secs = Math.floor(ms / 1000) + NTP_UNIX_EPOCH_DELTA;
  const frac = Math.floor(((ms % 1000) / 1000) * 0x100000000);
  buf.writeUInt32BE(secs >>> 0, off);
  buf.writeUInt32BE(frac >>> 0, off + 4);
}

// Read an NTP 64-bit timestamp back to JS epoch-ms (0 if the field is zero).
function readNtpTimestamp(buf, off) {
  const secs = buf.readUInt32BE(off);
  const frac = buf.readUInt32BE(off + 4);
  if (secs === 0 && frac === 0) return 0;
  return (secs - NTP_UNIX_EPOCH_DELTA) * 1000 + (frac / 0x100000000) * 1000;
}

// 32-bit 16.16 fixed-point (root delay / dispersion) → milliseconds.
function fixed1616ToMs(buf, off) {
  return (buf.readUInt32BE(off) / 0x10000) * 1000;
}

function buildRequest(txMs) {
  const buf = Buffer.alloc(48);
  buf[0] = 0x1b; // LI=0, VN=3, Mode=3 (client)
  writeNtpTimestamp(buf, 40, txMs); // Transmit Timestamp (server echoes to Originate)
  return buf;
}

// Reference identifier: an ASCII source code for stratum ≤ 1 (GPS/PPS/…),
// otherwise the IPv4 address of the upstream server.
function refId(buf, stratum) {
  const b = [buf[12], buf[13], buf[14], buf[15]];
  if (stratum <= 1) {
    const ascii = Buffer.from(b).toString('latin1').replace(/\0+$/, '').trim();
    return ascii || b.join('.');
  }
  return b.join('.');
}

function parse(buf, t1, t4) {
  if (buf.length < 48) return { error: 'short-frame' };
  const li = (buf[0] >> 6) & 0x03;
  const version = (buf[0] >> 3) & 0x07;
  const mode = buf[0] & 0x07;
  const stratum = buf[1];
  const t2 = readNtpTimestamp(buf, 32); // server receive
  const t3 = readNtpTimestamp(buf, 40); // server transmit
  // SNTP offset/delay from the four timestamps (RFC 4330 §5).
  const offsetMs = t2 && t3 ? ((t2 - t1) + (t3 - t4)) / 2 : null;
  const delayMs = t2 && t3 ? Math.max(0, (t4 - t1) - (t3 - t2)) : (t4 - t1);
  return {
    leap: li,
    leap_text: LEAP_TEXT[li],
    version,
    mode,
    stratum,
    poll_interval_s: buf[2] ? 2 ** (buf[2] & 0x3f) : 0,
    precision_s: 2 ** (buf.readInt8(3)),
    root_delay_ms: round(fixed1616ToMs(buf, 4)),
    root_dispersion_ms: round(fixed1616ToMs(buf, 8)),
    reference_id: refId(buf, stratum),
    reference_time: t3 ? new Date(readNtpTimestamp(buf, 16)).toISOString() : null,
    server_time: t3 ? new Date(t3).toISOString() : null,
    offset_ms: offsetMs == null ? null : round(offsetMs),
    delay_ms: round(delayMs),
  };
}

const round = (n) => (n == null ? null : Math.round(n * 1000) / 1000);

async function query(ctx) {
  const timeout = ctx.params?.timeout ?? 3000;
  const t1 = Date.now();
  const { data, rttMs } = await udpRequest(ctx.host, ctx.port || 123, buildRequest(t1), { timeout });
  const t4 = Date.now();
  return { request: buildRequest(t1), response: data, parsed: parse(data, t1, t4), rttMs };
}

function facts(p, rttMs) {
  const synced = p.stratum >= 1 && p.stratum <= 15 && p.leap !== 3;
  return {
    transport: { udp_response: 'success' },
    ntp: {
      stratum: p.stratum,
      leap: p.leap,
      synchronized: synced,
      offset_ms: p.offset_ms,
      abs_offset_ms: p.offset_ms == null ? null : Math.abs(p.offset_ms),
      root_dispersion_ms: p.root_dispersion_ms,
    },
    timeout: false,
    rtt_ms: rttMs,
  };
}

function errorFacts(err) {
  const timeout = err.code === 'ETIMEDOUT';
  return { transport: { udp_response: 'fail', error: err.code || err.message }, ntp: { synchronized: false }, timeout };
}

function bytesRaw(req, res) {
  return { tx: req ? Buffer.from(req).toString('hex') : null, rx: res ? Buffer.from(res).toString('hex') : null };
}

export const verbs = {
  async identify(ctx) {
    try {
      const r = await query(ctx);
      if (r.parsed.error) {
        return {
          artifact: makeArtifact({ verb: 'identify', raw: bytesRaw(r.request, r.response), result: { responded: false, error: r.parsed.error } }),
          facts: { transport: { udp_response: 'success' }, ntp: { synchronized: false }, timeout: false },
        };
      }
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: bytesRaw(r.request, r.response),
          decode: r.parsed,
          result: {
            stratum: r.parsed.stratum,
            leap: r.parsed.leap_text,
            reference_id: r.parsed.reference_id,
            server_time: r.parsed.server_time,
            offset_ms: r.parsed.offset_ms,
            delay_ms: r.parsed.delay_ms,
            root_dispersion_ms: r.parsed.root_dispersion_ms,
            rtt_ms: r.rttMs,
          },
        }),
        facts: facts(r.parsed, r.rttMs),
      };
    } catch (err) {
      return {
        artifact: makeArtifact({ verb: 'identify', raw: `error: ${err.code || err.message}`, result: { responded: false, error: err.code || err.message }, error: err }),
        facts: errorFacts(err),
      };
    }
  },

  // Monitor streams the clock offset over time — a drifting or hunting server
  // shows up as the offset walking away from zero.
  async monitorSample(ctx) {
    try {
      const r = await query(ctx);
      return { value: r.parsed.offset_ms, series: { offset_ms: r.parsed.offset_ms }, ok: !r.parsed.error && r.parsed.stratum >= 1 && r.parsed.stratum <= 15, raw: bytesRaw(r.request, r.response) };
    } catch (err) {
      return { value: null, ok: false, raw: `error: ${err.code || err.message}` };
    }
  },

  async diagnose(ctx) {
    try {
      const r = await query(ctx);
      return { facts: facts(r.parsed, r.rttMs), rulepack: 'ntp', raw: bytesRaw(r.request, r.response), decode: r.parsed };
    } catch (err) {
      return { facts: errorFacts(err), rulepack: 'ntp', raw: `error: ${err.code || err.message}` };
    }
  },
};
