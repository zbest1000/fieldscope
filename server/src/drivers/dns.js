// DNS driver (§6.1). Name resolution and reverse (PTR) lookups — the "does the
// HMI even resolve" check.

import dns from 'node:dns/promises';
import net from 'node:net';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'dns',
  display_name: 'DNS (A/PTR)',
  domain: 'it',
  group: 'discovery',
  transport: ['udp', 'tcp'],
  default_port: 53,
  mode: 'full',
  lib: '🟢',
  describe: 'Name resolution, reverse lookups.',
  verbs: ['identify', 'diagnose'],
};

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

  async diagnose(ctx) {
    const r = await resolveAll(ctx.host);
    return {
      facts: { resolved: r.resolved, a_count: r.a.length, ptr_count: r.ptr.length, error: r.error },
      rulepack: 'dns',
      raw: JSON.stringify(r, null, 2),
    };
  },
};
