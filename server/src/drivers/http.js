// HTTP / REST device probe (§6.1 IT / §6.4 IIoT). A large and growing share of
// edge gateways, IIoT bridges, PLwebservers, inverters, and building controllers
// expose a plain HTTP/JSON status or health endpoint — but the workbench had no
// way to ask "is that endpoint up, what does it answer, and how fast." This
// driver issues a real request and renders the status class as a verdict, decodes
// a JSON body into a browsable point tree, and streams latency for monitoring.
//
// Uses Node's built-in http/https (no external dependency, nothing fetched from
// the network at build time). TLS certificates are NOT validated — a diagnostics
// tool must still report a 200 from a box with a self-signed cert; use the TLS
// driver for the certificate audit itself.

import http from 'node:http';
import https from 'node:https';

import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'http',
  display_name: 'HTTP / REST',
  domain: 'iiot',
  group: 'tools',
  transport: ['tcp', 'tls'],
  default_port: 80,
  mode: 'full',
  lib: '🟢 node http/https',
  describe:
    'Probe an HTTP/REST endpoint: status-code verdict, latency, and JSON-body decode into a browsable point tree.',
  verbs: ['identify', 'read', 'monitor', 'diagnose'],
  params: {
    identify: {
      scheme: { type: 'enum', options: ['auto', 'http', 'https'], default: 'auto' },
      path: { type: 'string' },
      method: { type: 'enum', options: ['GET', 'HEAD'], default: 'GET' },
      timeout: { type: 'number', min: 200, max: 30000, default: 5000 },
    },
    read: {
      scheme: { type: 'enum', options: ['auto', 'http', 'https'], default: 'auto' },
      path: { type: 'string' },
      timeout: { type: 'number', min: 200, max: 30000, default: 5000 },
    },
    monitor: { path: { type: 'string' }, cadence: { type: 'number', min: 250, max: 60000, default: 2000 } },
  },
};

const MAX_BODY = 256 * 1024; // cap what we buffer from a probe

function schemeFor(ctx) {
  const s = ctx.params?.scheme ?? 'auto';
  if (s === 'http' || s === 'https') return s;
  return (ctx.port || 80) === 443 ? 'https' : 'http';
}

function request(ctx, method = 'GET') {
  const scheme = schemeFor(ctx);
  const lib = scheme === 'https' ? https : http;
  const port = ctx.port || (scheme === 'https' ? 443 : 80);
  const path = ctx.params?.path || '/';
  const timeout = ctx.params?.timeout ?? 5000;
  const started = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const req = lib.request(
      { host: ctx.host, port, path, method, timeout, rejectUnauthorized: false, headers: { Accept: 'application/json, */*', 'User-Agent': 'fieldscope/1.0', Connection: 'close' } },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
        res.on('end', () => {
          const ttfbMs = Number(process.hrtime.bigint() - started) / 1e6;
          resolve({ scheme, port, path, method, status: res.statusCode, statusMessage: res.statusMessage, headers: res.headers, body: Buffer.concat(chunks), truncated: size > MAX_BODY, rttMs: ttfbMs });
        });
      },
    );
    req.on('timeout', () => { req.destroy(tagged('ETIMEDOUT', `no HTTP response after ${timeout}ms`)); });
    req.on('error', reject);
    req.end();
  });
}

function tagged(code, message) { const e = new Error(message); e.code = code; return e; }

// Turn a parsed JSON body into a flat point tree (scalars keyed by dotted path);
// arrays and objects recurse, with a bound on total points.
function jsonTree(body, contentType) {
  if (!/json/i.test(contentType || '')) return null;
  let obj;
  try { obj = JSON.parse(body.toString('utf8')); } catch { return null; }
  const points = [];
  const walk = (v, prefix) => {
    if (points.length >= 200) return;
    if (v == null || typeof v !== 'object') { points.push({ ref: prefix || 'value', value: v == null ? 'null' : v, type: v == null ? 'null' : typeof v }); return; }
    for (const [k, val] of Object.entries(v)) walk(val, prefix ? `${prefix}.${k}` : k);
  };
  walk(obj, '');
  return points.length ? [{ area: 'JSON body', points }] : null;
}

function statusClass(status) { return status ? `${Math.floor(status / 100)}xx` : null; }

function facts(r) {
  return {
    transport: { tcp_connect: 'success' },
    http: { status: r.status, class: statusClass(r.status), ok: r.status >= 200 && r.status < 300, server: r.headers?.server || null },
    timeout: false,
    rtt_ms: r.rttMs,
  };
}

function errorFacts(err) {
  const timeout = err.code === 'ETIMEDOUT';
  return { transport: { tcp_connect: timeout ? 'success' : 'fail', error: err.code || err.message }, http: { ok: false }, timeout };
}

function rawView(r) {
  const reqLine = `${r.method} ${r.path} → ${r.scheme}://${r.host || ''}:${r.port}`;
  const head = `HTTP ${r.status} ${r.statusMessage || ''}`.trim();
  const hdrs = Object.entries(r.headers || {}).slice(0, 20).map(([k, v]) => `${k}: ${v}`).join('\n');
  return { text: `${reqLine}\n\n${head}\n${hdrs}` };
}

export const verbs = {
  async identify(ctx) {
    try {
      const r = await request(ctx, ctx.params?.method || 'GET');
      const contentType = r.headers['content-type'] || '';
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: rawView({ ...r, host: ctx.host }),
          result: {
            url: `${r.scheme}://${ctx.host}:${r.port}${r.path}`,
            status: r.status,
            status_text: r.statusMessage,
            status_class: statusClass(r.status),
            server: r.headers.server || null,
            content_type: contentType || null,
            content_length: r.headers['content-length'] ? Number(r.headers['content-length']) : r.body.length,
            rtt_ms: r.rttMs,
          },
        }),
        facts: facts(r),
      };
    } catch (err) {
      return {
        artifact: makeArtifact({ verb: 'identify', raw: `error: ${err.code || err.message}`, result: { reachable: false, error: err.code || err.message }, error: err }),
        facts: errorFacts(err),
      };
    }
  },

  // Read returns the response body — decoded into a point tree when it is JSON,
  // otherwise a bounded text preview.
  async read(ctx) {
    try {
      const r = await request(ctx, 'GET');
      const contentType = r.headers['content-type'] || '';
      const tree = jsonTree(r.body, contentType);
      const text = r.body.toString('utf8');
      return {
        artifact: makeArtifact({
          verb: 'read',
          raw: rawView({ ...r, host: ctx.host }),
          result: {
            url: `${r.scheme}://${ctx.host}:${r.port}${r.path}`,
            status: r.status,
            content_type: contentType || null,
            tree: tree || undefined,
            body_preview: tree ? undefined : text.slice(0, 2000),
            truncated: r.truncated || undefined,
            rtt_ms: r.rttMs,
          },
        }),
        facts: facts(r),
      };
    } catch (err) {
      return {
        artifact: makeArtifact({ verb: 'read', raw: `error: ${err.code || err.message}`, result: { reachable: false, error: err.code || err.message }, error: err }),
        facts: errorFacts(err),
      };
    }
  },

  async monitorSample(ctx) {
    try {
      const r = await request(ctx, 'GET');
      return { value: r.rttMs, series: { status: r.status }, ok: r.status >= 200 && r.status < 400, raw: rawView({ ...r, host: ctx.host }) };
    } catch (err) {
      return { value: null, ok: false, raw: `error: ${err.code || err.message}` };
    }
  },

  async diagnose(ctx) {
    try {
      const r = await request(ctx, 'GET');
      return { facts: facts(r), rulepack: 'http', raw: rawView({ ...r, host: ctx.host }) };
    } catch (err) {
      return { facts: errorFacts(err), rulepack: 'http', raw: `error: ${err.code || err.message}` };
    }
  },
};
