// TCP/UDP connect-probe driver (§6.1). Port state, and the classic
// SYN-accept-but-drop detection that separates a firewall from a dead service.

import { tcpConnect } from '../transport/transport.js';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'tcp-probe',
  display_name: 'TCP/UDP Probe',
  domain: 'it',
  group: 'tools',
  transport: ['tcp'],
  default_port: 502,
  mode: 'full',
  lib: '🟢',
  describe: 'Port state, SYN-accept-but-drop detection.',
  verbs: ['connect', 'diagnose'],
  params: {
    connect: { timeout: { type: 'number', default: 3000, min: 200, max: 20000 } },
  },
};

async function probe(host, port, timeout) {
  try {
    const { socket, connectMs } = await tcpConnect(host, port, timeout);
    socket.destroy();
    return { state: 'open', connectMs, error: null };
  } catch (err) {
    let state = 'error';
    if (err.code === 'ECONNREFUSED') state = 'closed';
    else if (err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH') state = 'filtered';
    return { state, connectMs: null, error: err.code || err.message };
  }
}

export const verbs = {
  async connect(ctx) {
    const timeout = ctx.params?.timeout ?? 3000;
    const r = await probe(ctx.host, ctx.port, timeout);
    return {
      artifact: makeArtifact({
        verb: 'connect',
        raw: `TCP connect ${ctx.host}:${ctx.port} -> ${r.state}${r.connectMs ? ` (${r.connectMs.toFixed(1)}ms)` : ''}${r.error ? ` [${r.error}]` : ''}`,
        result: { host: ctx.host, port: ctx.port, state: r.state, connect_ms: r.connectMs, error: r.error },
      }),
      facts: { state: r.state, connect_ms: r.connectMs, error: r.error },
    };
  },

  async diagnose(ctx) {
    const r = await probe(ctx.host, ctx.port, ctx.params?.timeout ?? 3000);
    return {
      facts: { state: r.state, connect_ms: r.connectMs, error: r.error, port: ctx.port },
      rulepack: 'tcp-probe',
      raw: `TCP connect ${ctx.host}:${ctx.port} -> ${r.state}`,
    };
  },
};
