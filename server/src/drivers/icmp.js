// ICMP driver (§6.1, §12 phase 1). The trivial driver that proves the
// manifest/verb/artifact loop end-to-end.
//
// Raw ICMP needs root + raw sockets. To stay privilege-free and cross-platform,
// this driver shells out to the system `ping`, parses reachability + RTT, and
// still returns the uniform Artifact with a "raw" transcript so the Raw tab has
// something real to show.

import { execFile } from 'node:child_process';
import os from 'node:os';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'icmp',
  display_name: 'ICMP (ping)',
  domain: 'it',
  group: 'discovery',
  transport: ['icmp'],
  default_port: null,
  requires_admin: false,
  mode: 'full',
  lib: '🟢',
  describe: 'Reachability, RTT baseline. The top "is it even on the network" check.',
  verbs: ['identify', 'monitor', 'diagnose'],
  params: {
    identify: { count: { type: 'number', default: 4, min: 1, max: 20 } },
    monitor: { cadence: { type: 'number', default: 1000, min: 250, max: 10000 } },
  },
};

function ping(host, count) {
  const isWin = os.platform() === 'win32';
  const args = isWin ? ['-n', String(count), host] : ['-c', String(count), '-w', '5', host];
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || '', failed: !!err });
    });
  });
}

function parse(stdout) {
  const times = [...stdout.matchAll(/time[=<]\s*([\d.]+)\s*ms/gi)].map((m) => Number(m[1]));
  const txMatch = stdout.match(/(\d+)\s+packets transmitted/i);
  const rxMatch = stdout.match(/(\d+)\s+(?:packets )?received/i);
  const transmitted = txMatch ? Number(txMatch[1]) : times.length;
  const received = rxMatch ? Number(rxMatch[1]) : times.length;
  const loss = transmitted ? (transmitted - received) / transmitted : 1;
  const stats =
    times.length > 0
      ? {
          min: Math.min(...times),
          avg: times.reduce((a, b) => a + b, 0) / times.length,
          max: Math.max(...times),
          jitter: times.length > 1 ? stddev(times) : 0,
        }
      : null;
  return { transmitted, received, loss, times, stats };
}

function stddev(xs) {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

// Facts for the icmp rulepack.
function facts(p) {
  return {
    reachable: p.received > 0,
    loss_pct: Math.round(p.loss * 100),
    received: p.received,
    transmitted: p.transmitted,
    rtt_avg: p.stats ? p.stats.avg : null,
    jitter: p.stats ? p.stats.jitter : null,
  };
}

export const verbs = {
  async identify(ctx) {
    const count = ctx.params?.count ?? 4;
    const { stdout, stderr } = await ping(ctx.host, count);
    const p = parse(stdout);
    return {
      artifact: makeArtifact({
        verb: 'identify',
        raw: stdout + (stderr ? `\n${stderr}` : ''),
        result: {
          host: ctx.host,
          reachable: p.received > 0,
          transmitted: p.transmitted,
          received: p.received,
          loss_pct: Math.round(p.loss * 100),
          rtt: p.stats,
        },
      }),
      facts: facts(p),
    };
  },

  async diagnose(ctx) {
    const { stdout } = await ping(ctx.host, ctx.params?.count ?? 4);
    const p = parse(stdout);
    return { facts: facts(p), rulepack: 'icmp', raw: stdout };
  },

  // Monitor emits one sample per tick; the orchestrator handles cadence and
  // rolls the sparkline/stats.
  async monitorSample(ctx) {
    const { stdout } = await ping(ctx.host, 1);
    const p = parse(stdout);
    const rtt = p.times[0] ?? null;
    return { value: rtt, ok: p.received > 0, raw: stdout };
  },
};
