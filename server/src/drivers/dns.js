// DNS driver (§6.1). Name resolution and reverse (PTR) lookups — the "does the
// HMI even resolve" check.

import dns from 'node:dns/promises';
import net from 'node:net';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'dns',
  display_name: 'DNS',
  domain: 'it',
  group: 'discovery',
  transport: ['udp', 'tcp'],
  default_port: 53,
  mode: 'full',
  lib: '🟢',
  describe: 'Name resolution + reverse (identify); typed record lookups (A/AAAA/MX/TXT/NS/CNAME/SOA) against a chosen server.',
  verbs: ['identify', 'read', 'diagnose'],
  params: {
    // Look up one record type for `name`, querying `server` (an IP) directly if
    // given, else the system resolver — the "does *this* DNS server resolve X".
    read: {
      name: { type: 'string', default: '' },
      type: { type: 'enum', options: ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA', 'PTR'], default: 'A' },
      server: { type: 'string', default: '' },
      timeout: { type: 'number', default: 3000, min: 500, max: 10000 },
    },
  },
};

// Resolve one record type for `name`. When `server` (or the session host) is an
// IP, query it directly on the session port; otherwise use the system resolver.
async function resolveRecords(ctx, name, type) {
  const timeout = Math.min(ctx.params?.timeout ?? 3000, 8000);
  const resolver = new dns.Resolver({ timeout, tries: 1 });
  const server = ctx.params?.server || (net.isIP(ctx.host) ? ctx.host : null);
  if (server && net.isIP(server)) resolver.setServers([`${server}:${ctx.port || 53}`]);
  const t = String(type || 'A').toUpperCase();
  const fns = {
    A: () => resolver.resolve4(name),
    AAAA: () => resolver.resolve6(name),
    MX: () => resolver.resolveMx(name),
    TXT: () => resolver.resolveTxt(name),
    NS: () => resolver.resolveNs(name),
    CNAME: () => resolver.resolveCname(name),
    SOA: () => resolver.resolveSoa(name),
    PTR: () => resolver.reverse(name),
  };
  if (!fns[t]) return { type: t, error: `unsupported type ${t}`, records: [] };
  try {
    return { type: t, records: normalizeRecords(t, await fns[t]()), server: server || 'system' };
  } catch (err) {
    return { type: t, error: err.code || err.message, records: [], server: server || 'system' };
  }
}

// Flatten library-specific shapes (MX objects, TXT chunk arrays, SOA object)
// into display strings.
function normalizeRecords(t, recs) {
  if (t === 'MX') return recs.map((r) => `${r.priority} ${r.exchange}`);
  if (t === 'TXT') return recs.map((r) => (Array.isArray(r) ? r.join('') : String(r)));
  if (t === 'SOA') return [`${recs.nsname} ${recs.hostmaster} serial ${recs.serial}`];
  return recs.map(String);
}

async function resolveAll(host) {
  const out = { host, a: [], aaaa: [], ptr: [], error: null };
  try {
    if (net.isIP(host)) {
      out.ptr = await dns.reverse(host).catch(() => []);
    } else {
      out.a = (await dns.resolve4(host).catch(() => [])) || [];
      out.aaaa = (await dns.resolve6(host).catch(() => [])) || [];
    }
  } catch (err) {
    out.error = err.code || err.message;
  }
  out.resolved = out.a.length + out.aaaa.length + out.ptr.length > 0;
  return out;
}

export const verbs = {
  async identify(ctx) {
    const r = await resolveAll(ctx.host);
    return {
      artifact: makeArtifact({
        verb: 'identify',
        raw: JSON.stringify(r, null, 2),
        result: r,
      }),
      facts: { resolved: r.resolved, a_count: r.a.length, ptr_count: r.ptr.length, error: r.error },
    };
  },

  // Read = a typed record lookup (A/AAAA/MX/TXT/NS/CNAME/SOA/PTR), rendered as a
  // table of the returned records.
  async read(ctx) {
    const name = ctx.params?.name || ctx.host;
    const type = ctx.params?.type || 'A';
    const r = await resolveRecords(ctx, name, type);
    return {
      artifact: makeArtifact({
        verb: 'read',
        raw: `${type} ${name} @${r.server} → ${r.error ? r.error : `${r.records.length} record(s)`}`,
        decode: r,
        result: r.records.length
          ? {
              name,
              type: r.type,
              server: r.server,
              records: r.records.length,
              tree: [{ area: `${name} ${r.type} @ ${r.server}`, points: r.records.map((rec, i) => ({ ref: `${r.type} #${i + 1}`, value: rec, type: '' })) }],
            }
          : { name, type: r.type, server: r.server, records: 0, error: r.error ?? null, note: r.error ? undefined : 'no records of this type' },
      }),
      facts: { resolved: r.records.length > 0, type: r.type, error: r.error ?? null },
    };
  },

  async diagnose(ctx) {
    const r = await resolveAll(ctx.host);
    return {
      facts: { resolved: r.resolved, a_count: r.a.length, ptr_count: r.ptr.length, error: r.error },
      rulepack: 'dns',
      raw: JSON.stringify(r, null, 2),
    };
  },
};
