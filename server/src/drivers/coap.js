// CoAP driver (§6.4 IIoT, RFC 7252). CoAP is the constrained-device REST analog
// of HTTP — a compact binary request/response over UDP that battery- and
// bandwidth-limited IoT sensors, LwM2M endpoints, and 6LoWPAN nodes speak where
// full HTTP is too heavy. Its discovery mechanism is a well-known resource list
// at /.well-known/core in CoRE Link Format (RFC 6690).
//
// This driver issues a real CoAP GET, decodes the response code (2.05 Content,
// 4.04 Not Found, …), and — the flagship — enumerates a device's resources from
// /.well-known/core into a browsable tree with their resource types. Raw binary
// CoAP codec, dependency-free.

import { udpRequest } from '../transport/transport.js';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'coap',
  display_name: 'CoAP',
  domain: 'iiot',
  group: 'iiot',
  transport: ['udp'],
  default_port: 5683,
  mode: 'full',
  lib: '🟢 raw CoAP (RFC 7252)',
  describe:
    'Constrained-device REST: GET a CoAP resource, decode the response code, and enumerate /.well-known/core into a resource tree (CoRE Link Format).',
  verbs: ['identify', 'browse', 'read', 'diagnose'],
  params: {
    identify: { timeout: { type: 'number', min: 200, max: 15000, default: 3000 } },
    browse: { timeout: { type: 'number', min: 200, max: 15000, default: 3000 } },
    read: { path: { type: 'string' }, timeout: { type: 'number', min: 200, max: 15000, default: 3000 } },
  },
};

const T_CON = 0;
const CODE_GET = 0x01;
let mid = 0;
function nextMid() { mid = (mid + 1) & 0xffff; return mid; }

// Build a confirmable GET for a slash path ("/.well-known/core" → segments).
function buildGet(path, messageId) {
  const segments = String(path || '/').split('/').filter(Boolean);
  const token = Buffer.from([0x42]); // 1-byte token
  const header = Buffer.from([0x40 | (T_CON << 4) | token.length, CODE_GET, (messageId >> 8) & 0xff, messageId & 0xff]);
  const opts = [];
  let lastOpt = 0;
  for (const seg of segments) {
    const bytes = Buffer.from(seg, 'utf8');
    const delta = 11 - lastOpt; // Uri-Path = option 11
    lastOpt = 11;
    opts.push(optionHeader(delta, bytes.length), bytes);
  }
  return Buffer.concat([header, token, ...opts]);
}

// Option header with 4-bit delta/length nibbles + 13/14 extended forms.
function optionHeader(delta, len) {
  const enc = (v) => (v < 13 ? [v, []] : v < 269 ? [13, [v - 13]] : [14, [(v - 269) >> 8, (v - 269) & 0xff]]);
  const [dn, dext] = enc(delta);
  const [ln, lext] = enc(len);
  return Buffer.from([(dn << 4) | ln, ...dext, ...lext]);
}

function codeText(code) {
  const cls = code >> 5;
  const detail = code & 0x1f;
  return `${cls}.${String(detail).padStart(2, '0')}`;
}

function parse(buf) {
  if (buf.length < 4) return { error: 'short-frame' };
  const type = (buf[0] >> 4) & 0x03;
  const tkl = buf[0] & 0x0f;
  const code = buf[1];
  const messageId = (buf[2] << 8) | buf[3];
  let o = 4 + tkl;
  // Walk options until the payload marker (0xFF) or end of buffer.
  while (o < buf.length) {
    if (buf[o] === 0xff) { o += 1; break; }
    const b = buf[o]; o += 1;
    let delta = b >> 4;
    let len = b & 0x0f;
    if (delta === 13) { delta = buf[o] + 13; o += 1; } else if (delta === 14) { delta = ((buf[o] << 8) | buf[o + 1]) + 269; o += 2; }
    if (len === 13) { len = buf[o] + 13; o += 1; } else if (len === 14) { len = ((buf[o] << 8) | buf[o + 1]) + 269; o += 2; }
    o += len;
  }
  const payload = o <= buf.length ? buf.subarray(o) : Buffer.alloc(0);
  return { type, code, code_text: codeText(code), message_id: messageId, payload };
}

// CoRE Link Format (RFC 6690): <uri>;attr=val;attr="val", comma-separated.
function parseLinkFormat(text) {
  const out = [];
  const re = /<([^>]*)>([^,]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const uri = m[1];
    const attrs = {};
    for (const a of m[2].split(';')) {
      const t = a.trim();
      if (!t) continue;
      const eq = t.indexOf('=');
      if (eq < 0) attrs[t] = true;
      else attrs[t.slice(0, eq)] = t.slice(eq + 1).replace(/^"|"$/g, '');
    }
    out.push({ uri, rt: attrs.rt || null, if: attrs.if || null, title: attrs.title || null });
  }
  return out;
}

async function get(ctx, path) {
  const timeout = ctx.params?.timeout ?? 3000;
  const req = buildGet(path, nextMid());
  const { data, rttMs } = await udpRequest(ctx.host, ctx.port || 5683, req, { timeout });
  return { request: req, response: data, parsed: parse(data), rttMs };
}

function facts(parsed, rttMs) {
  const cls = parsed.code >> 5;
  return {
    transport: { udp_response: 'success' },
    coap: { code: parsed.code_text, class: cls, ok: cls === 2 },
    timeout: false,
    rtt_ms: rttMs,
  };
}

function errorFacts(err) {
  const timeout = err.code === 'ETIMEDOUT';
  return { transport: { udp_response: 'fail', error: err.code || err.message }, coap: { ok: false }, timeout };
}

function bytesRaw(req, res) {
  return { tx: req ? Buffer.from(req).toString('hex') : null, rx: res ? Buffer.from(res).toString('hex') : null };
}

export const verbs = {
  async identify(ctx) {
    try {
      const r = await get(ctx, '/.well-known/core');
      const links = r.parsed.payload?.length ? parseLinkFormat(r.parsed.payload.toString('utf8')) : [];
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: bytesRaw(r.request, r.response),
          decode: r.parsed,
          result: { code: r.parsed.code_text, resources: links.length, rtt_ms: r.rttMs },
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

  // Browse enumerates /.well-known/core into a resource tree.
  async browse(ctx) {
    try {
      const r = await get(ctx, '/.well-known/core');
      const links = r.parsed.payload?.length ? parseLinkFormat(r.parsed.payload.toString('utf8')) : [];
      const tree = [{
        area: `${links.length} resource(s) · CoRE Link Format`,
        points: links.map((l) => ({ ref: l.uri, value: l.title || l.rt || '', type: l.rt || l.if || 'resource' })),
      }];
      return {
        artifact: makeArtifact({
          verb: 'browse',
          raw: bytesRaw(r.request, r.response),
          result: { code: r.parsed.code_text, resources: links.length, tree, rtt_ms: r.rttMs },
        }),
        facts: facts(r.parsed, r.rttMs),
      };
    } catch (err) {
      return {
        artifact: makeArtifact({ verb: 'browse', raw: `error: ${err.code || err.message}`, error: err }),
        facts: errorFacts(err),
      };
    }
  },

  async read(ctx) {
    const path = ctx.params?.path || '/.well-known/core';
    try {
      const r = await get(ctx, path);
      const text = r.parsed.payload?.toString('utf8') ?? '';
      return {
        artifact: makeArtifact({
          verb: 'read',
          raw: bytesRaw(r.request, r.response),
          decode: r.parsed,
          result: { path, code: r.parsed.code_text, payload: text.slice(0, 2000), payload_bytes: r.parsed.payload?.length || 0, rtt_ms: r.rttMs },
        }),
        facts: facts(r.parsed, r.rttMs),
      };
    } catch (err) {
      return {
        artifact: makeArtifact({ verb: 'read', raw: `error: ${err.code || err.message}`, result: { path, error: err.code || err.message }, error: err }),
        facts: errorFacts(err),
      };
    }
  },

  async diagnose(ctx) {
    try {
      const r = await get(ctx, '/.well-known/core');
      return { facts: facts(r.parsed, r.rttMs), rulepack: 'coap', raw: bytesRaw(r.request, r.response), decode: r.parsed };
    } catch (err) {
      return { facts: errorFacts(err), rulepack: 'coap', raw: `error: ${err.code || err.message}` };
    }
  },
};

export { buildGet, parse, parseLinkFormat };
