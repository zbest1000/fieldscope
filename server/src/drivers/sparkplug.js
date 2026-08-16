// Sparkplug B driver (§6.4, §12 phase 5). The protocol that defines the UNS
// (Unified Namespace) story: MQTT with a strict birth/death lifecycle and a
// per-node sequence number. Its two signature diagnostics are exactly what this
// driver reports:
//   1. Sequence continuity. Every message from a node carries seq (0–255,
//      wrapping); NBIRTH resets it to 0. A gap means messages were lost — a QoS,
//      broker, or network problem that silently drops data in a UNS.
//   2. Birth/death lifecycle. NBIRTH/DBIRTH announce a node/device and its
//      metric aliases; NDEATH (delivered via the MQTT Last-Will) means the node
//      dropped. Seeing DATA without a prior BIRTH means you joined mid-stream and
//      need to trigger a rebirth to resolve the aliases.
//
// Sparkplug payloads are protobuf (Eclipse Tahu schema). Rather than pull in the
// Tahu library, this ships a minimal protobuf reader for the handful of fields
// diagnostics needs (seq, metric names/aliases) — dependency-light, like the
// other raw drivers, and it still decodes real payloads on the wire.

import mqttlib from 'mqtt';
import crypto from 'node:crypto';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'sparkplug',
  display_name: 'Sparkplug B',
  domain: 'iiot',
  group: 'iiot',
  transport: ['tcp'],
  default_port: 1883,
  mode: 'full',
  lib: '🟢 minimal protobuf codec',
  describe:
    'Birth/death lifecycle tracking, per-node sequence-gap detection, and metric-alias resolution over MQTT.',
  verbs: ['connect', 'browse', 'read', 'monitor', 'diagnose'],
  params: {
    connect: { username: { type: 'string' }, password: { type: 'string' } },
    browse: {
      group: { type: 'string', default: '#' },
      window_ms: { type: 'number', default: 3000, min: 500, max: 15000 },
      username: { type: 'string' },
      password: { type: 'string' },
    },
    read: {
      group: { type: 'string', default: '#' },
      window_ms: { type: 'number', default: 3000, min: 500, max: 15000 },
      username: { type: 'string' },
      password: { type: 'string' },
    },
    diagnose: {
      window_ms: { type: 'number', default: 3000, min: 500, max: 15000 },
      username: { type: 'string' },
      password: { type: 'string' },
    },
  },
};

// ---- minimal protobuf reader (varint + length-delimited only) --------------
function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  while (p < buf.length) {
    const b = buf[p++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: result, pos: p };
}

// Decode a Sparkplug Payload: we care about seq (field 3) and metrics (field 2,
// each a submessage carrying name (1) and alias (2)).
export function decodePayload(buf) {
  let pos = 0;
  let seq = null;
  let timestamp = null;
  const metrics = [];
  while (pos < buf.length) {
    const { value: tag, pos: p1 } = readVarint(buf, pos);
    pos = p1;
    const field = Number(tag >> 3n);
    const wtype = Number(tag & 0x7n);
    if (wtype === 0) {
      const { value, pos: p2 } = readVarint(buf, pos);
      pos = p2;
      if (field === 3) seq = Number(value);
      else if (field === 1) timestamp = Number(value);
    } else if (wtype === 2) {
      const { value: len, pos: p2 } = readVarint(buf, pos);
      pos = p2;
      const end = pos + Number(len);
      const sub = buf.subarray(pos, end);
      if (field === 2) metrics.push(decodeMetric(sub));
      pos = end;
    } else if (wtype === 1) {
      pos += 8; // 64-bit
    } else if (wtype === 5) {
      pos += 4; // 32-bit
    } else {
      break; // unknown wire type — stop rather than misparse
    }
  }
  return { seq, timestamp, metrics };
}

function decodeMetric(buf) {
  let pos = 0;
  let name = null;
  let alias = null;
  let datatype = null;
  let value; // Sparkplug value fields: 10 int, 11 long, 12 float, 13 double, 14 bool, 15 string
  while (pos < buf.length) {
    const { value: tag, pos: p1 } = readVarint(buf, pos);
    pos = p1;
    const field = Number(tag >> 3n);
    const wtype = Number(tag & 0x7n);
    if (wtype === 2) {
      const { value: len, pos: p2 } = readVarint(buf, pos);
      pos = p2;
      const end = pos + Number(len);
      if (field === 1) name = buf.subarray(pos, end).toString('utf8');
      else if (field === 15) value = buf.subarray(pos, end).toString('utf8'); // string_value
      pos = end;
    } else if (wtype === 0) {
      const { value: v, pos: p2 } = readVarint(buf, pos);
      pos = p2;
      if (field === 2) alias = Number(v);
      else if (field === 4) datatype = Number(v);
      else if (field === 10 || field === 11) value = Number(v); // int / long value
      else if (field === 14) value = Number(v) !== 0; // boolean value
    } else if (wtype === 1) {
      if (field === 13) value = buf.readDoubleLE(pos); // double value
      pos += 8;
    } else if (wtype === 5) {
      if (field === 12) value = Math.round(buf.readFloatLE(pos) * 1000) / 1000; // float value
      pos += 4;
    } else break;
  }
  return { name, alias, datatype, value: value === undefined ? null : value };
}

// ---- minimal protobuf writer (for the simulator / tests) -------------------
function writeVarint(n) {
  const bytes = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}
function tag(field, wtype) {
  return writeVarint((field << 3) | wtype);
}
function lenDelim(field, payload) {
  return Buffer.concat([tag(field, 2), writeVarint(payload.length), payload]);
}
export function encodeMetric({ name, alias, datatype = 3, intValue = 0 }) {
  const parts = [];
  if (name != null) parts.push(lenDelim(1, Buffer.from(name, 'utf8')));
  if (alias != null) parts.push(Buffer.concat([tag(2, 0), writeVarint(alias)]));
  if (datatype != null) parts.push(Buffer.concat([tag(4, 0), writeVarint(datatype)]));
  parts.push(Buffer.concat([tag(10, 0), writeVarint(intValue)])); // int_value
  return Buffer.concat(parts);
}
export function encodePayload({ seq, timestamp = 0, metrics = [] }) {
  const parts = [Buffer.concat([tag(1, 0), writeVarint(timestamp)])];
  for (const m of metrics) parts.push(lenDelim(2, encodeMetric(m)));
  if (seq != null) parts.push(Buffer.concat([tag(3, 0), writeVarint(seq)]));
  return Buffer.concat(parts);
}

// ---- Sparkplug topic parsing -----------------------------------------------
// spBv1.0/<group>/<msgType>/<edgeNode>[/<device>]
function parseTopic(topic) {
  const parts = topic.split('/');
  if (parts[0] !== 'spBv1.0' || parts.length < 4) return null;
  return { group: parts[1], type: parts[2], node: parts[3], device: parts[4] || null };
}

// Collect Sparkplug traffic for a window and reduce it to per-node lifecycle +
// sequence-continuity facts.
async function observe(ctx, { windowMs, filter = 'spBv1.0/#' } = {}) {
  const timeout = ctx.params?.timeout ?? 3000;
  const url = `mqtt://${ctx.host}:${ctx.port || 1883}`;
  const client = mqttlib.connect(url, {
    protocolVersion: 4,
    clientId: `fieldscope_sp_${crypto.randomBytes(4).toString('hex')}`,
    connectTimeout: timeout,
    reconnectPeriod: 0,
    clean: true,
    username: ctx.params?.username || undefined,
    password: ctx.params?.password || undefined,
  });

  const nodes = new Map(); // key group/node -> state
  const events = [];
  const keyOf = (t) => `${t.group}/${t.node}`;

  const connected = await new Promise((resolve) => {
    client.once('connect', () => resolve(true));
    client.once('error', () => resolve(false));
    setTimeout(() => resolve(false), timeout + 500);
  });
  if (!connected) {
    try { client.end(true); } catch { /* noop */ }
    return { connected: false, nodes: [], events: [] };
  }

  await new Promise((resolve) => {
    client.subscribe(filter, { qos: 0 }, () => {});
    client.on('message', (topic, payload) => {
      const t = parseTopic(topic);
      if (!t) return;
      let decoded = null;
      try { decoded = decodePayload(payload); } catch { decoded = null; }
      const seq = decoded ? decoded.seq : null;
      const k = keyOf(t);
      let st = nodes.get(k);
      if (!st) {
        st = { group: t.group, node: t.node, births: 0, deaths: 0, messages: 0, lastSeq: null, gaps: 0, sawBirthFirst: null, metrics: 0, online: true, aliasToName: new Map(), metricValues: new Map() };
        nodes.set(k, st);
      }
      st.messages += 1;
      // Resolve metric aliases from births and track the latest value per metric
      // (DATA carries alias-only, so the birth's alias→name map is required).
      if (decoded && decoded.metrics) {
        for (const m of decoded.metrics) {
          if (m.name != null && m.alias != null) st.aliasToName.set(m.alias, m.name);
          const nm = m.name ?? (m.alias != null ? st.aliasToName.get(m.alias) : null) ?? (m.alias != null ? `alias ${m.alias}` : 'unnamed');
          if (m.value !== null && m.value !== undefined) st.metricValues.set(nm, m.value);
          else if (!st.metricValues.has(nm)) st.metricValues.set(nm, null);
        }
      }
      if (t.type === 'NBIRTH' || t.type === 'DBIRTH') {
        st.births += 1;
        st.online = true;
        if (st.sawBirthFirst === null) st.sawBirthFirst = true;
        if (decoded && decoded.metrics) st.metrics += decoded.metrics.length;
      } else if (t.type === 'NDEATH' || t.type === 'DDEATH') {
        st.deaths += 1;
        st.online = false;
        events.push({ type: t.type, node: k });
      } else {
        // DATA before any birth means we joined mid-stream.
        if (st.sawBirthFirst === null) st.sawBirthFirst = false;
      }
      // Sequence continuity: seq wraps 0..255, incrementing by 1 each message.
      if (seq != null) {
        if (st.lastSeq != null) {
          const expected = (st.lastSeq + 1) & 0xff;
          if (t.type !== 'NBIRTH' && seq !== expected) {
            st.gaps += 1;
            events.push({ type: 'SEQ_GAP', node: k, expected, got: seq });
          }
        }
        st.lastSeq = seq;
      }
    });
    setTimeout(resolve, windowMs);
  });
  try { client.end(true); } catch { /* noop */ }
  return { connected: true, nodes: [...nodes.values()], events };
}

function summarize(obs) {
  const totalGaps = obs.nodes.reduce((a, n) => a + n.gaps, 0);
  const deaths = obs.nodes.reduce((a, n) => a + n.deaths, 0);
  const joinedMidStream = obs.nodes.filter((n) => n.sawBirthFirst === false).length;
  const offline = obs.nodes.filter((n) => !n.online).length;
  return {
    nodes_seen: obs.nodes.length,
    with_gaps: obs.nodes.filter((n) => n.gaps > 0).length,
    total_gaps: totalGaps,
    deaths,
    offline_nodes: offline,
    joined_mid_stream: joinedMidStream,
  };
}

export const verbs = {
  async connect(ctx) {
    const obs = await observe(ctx, { windowMs: 300 });
    return {
      artifact: makeArtifact({
        verb: 'connect',
        raw: `MQTT connect ${ctx.host}:${ctx.port || 1883} for Sparkplug B → ${obs.connected ? 'connected' : 'failed'}`,
        result: { connected: obs.connected },
      }),
      facts: { transport: { mqtt_connect: obs.connected ? 'success' : 'fail' } },
    };
  },

  // Browse = observe the namespace and render the node/device tree with each
  // node's lifecycle state, metric count, and any sequence gaps.
  async browse(ctx) {
    const windowMs = Math.min(15000, Math.max(500, ctx.params?.window_ms ?? 3000));
    const group = ctx.params?.group && ctx.params.group !== '#' ? ctx.params.group : null;
    const filter = group ? `spBv1.0/${group}/#` : 'spBv1.0/#';
    const obs = await observe(ctx, { windowMs, filter });
    if (!obs.connected) {
      return {
        artifact: makeArtifact({ verb: 'browse', raw: 'MQTT connect failed', result: { error: 'connect failed' }, error: new Error('connect failed') }),
        facts: {},
      };
    }
    const points = obs.nodes.map((n) => ({
      ref: `${n.group}/${n.node}`,
      value: `${n.online ? 'online' : 'OFFLINE'} · ${n.messages} msg · seq ${n.lastSeq ?? '—'}`,
      type: `${n.births} birth · ${n.metrics} metrics${n.gaps ? ` · ${n.gaps} gap(s)` : ''}`,
    }));
    return {
      artifact: makeArtifact({
        verb: 'browse',
        raw: `observed spBv1.0 for ${windowMs}ms → ${obs.nodes.length} node(s), ${obs.events.length} lifecycle/seq event(s)`,
        result: { tree: [{ area: `Sparkplug namespace (${windowMs}ms window)`, points }], ...summarize(obs) },
      }),
      facts: {},
    };
  },

  // Read = the latest metric values per node, with aliases resolved to names
  // from the births (DATA carries alias-only).
  async read(ctx) {
    const windowMs = Math.min(15000, Math.max(500, ctx.params?.window_ms ?? 3000));
    const group = ctx.params?.group && ctx.params.group !== '#' ? ctx.params.group : null;
    const filter = group ? `spBv1.0/${group}/#` : 'spBv1.0/#';
    const obs = await observe(ctx, { windowMs, filter });
    if (!obs.connected) {
      return {
        artifact: makeArtifact({ verb: 'read', raw: 'MQTT connect failed', result: { error: 'connect failed' }, error: new Error('connect failed') }),
        facts: {},
      };
    }
    const withMetrics = obs.nodes.filter((n) => n.metricValues.size > 0);
    const tree = withMetrics.map((n) => ({
      area: `${n.group}/${n.node} · ${n.metricValues.size} metric(s)${n.online ? '' : ' · OFFLINE'}`,
      points: [...n.metricValues.entries()].map(([name, val]) => ({ ref: name, value: val === null ? '—' : val, type: '' })),
    }));
    const metricTotal = withMetrics.reduce((a, n) => a + n.metricValues.size, 0);
    return {
      artifact: makeArtifact({
        verb: 'read',
        raw: `observed spBv1.0 for ${windowMs}ms → ${withMetrics.length} node(s), ${metricTotal} metric(s)`,
        result: tree.length ? { tree, nodes: withMetrics.length, metrics: metricTotal } : { nodes: 0, note: 'no metrics observed in the window' },
      }),
      facts: {},
    };
  },

  async monitorSample(ctx) {
    const obs = await observe(ctx, { windowMs: 1000 });
    const s = summarize(obs);
    return { value: s.total_gaps, ok: obs.connected && s.total_gaps === 0, raw: `nodes ${s.nodes_seen}, gaps ${s.total_gaps}, deaths ${s.deaths}` };
  },

  async diagnose(ctx) {
    const windowMs = Math.min(15000, Math.max(500, ctx.params?.window_ms ?? 3000));
    const obs = await observe(ctx, { windowMs });
    if (!obs.connected) {
      return { facts: { transport: { mqtt_connect: 'fail' } }, rulepack: 'sparkplug', raw: 'MQTT connect failed' };
    }
    const s = summarize(obs);
    return {
      facts: {
        transport: { mqtt_connect: 'success' },
        sparkplug: s,
        timeout: false,
      },
      rulepack: 'sparkplug',
      raw: `spBv1.0 ${windowMs}ms: ${s.nodes_seen} node(s), ${s.total_gaps} seq gap(s), ${s.deaths} death(s), ${s.joined_mid_stream} joined-mid-stream`,
      decode: obs.events.slice(0, 20),
    };
  },
};
