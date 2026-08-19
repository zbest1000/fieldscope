// MQTT 3.1.1 driver (§6.4, §12 phase 5). The IIoT workhorse — and a deliberate
// demonstration that the driver contract absorbs a message-broker shape as
// cleanly as a register-map shape: browse renders the live topic tree, and
// *publish* is the write verb, cleared through exactly the same ARM +
// per-write-confirm double-gate as a Modbus register write (§4.1), with a
// retained-message read-back as its verification.

import mqttlib from 'mqtt';
import crypto from 'node:crypto';
import { tcpConnect } from '../transport/transport.js';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'mqtt',
  display_name: 'MQTT 3.1.1',
  domain: 'iiot',
  group: 'iiot',
  transport: ['tcp'],
  default_port: 1883,
  write_capable: true,
  mode: 'full',
  lib: '🟢 mqtt.js',
  describe:
    'CONNACK verdicts (auth, protocol), topic-tree explorer with retained/LWT visibility, ARM-gated publish with retained read-back.',
  verbs: ['connect', 'identify', 'browse', 'write', 'monitor', 'diagnose'],
  params: {
    connect: {
      username: { type: 'string' },
      password: { type: 'string' },
    },
    browse: {
      filter: { type: 'string', default: '#' },
      window_ms: { type: 'number', default: 2000, min: 500, max: 10000 },
      username: { type: 'string' },
      password: { type: 'string' },
    },
    write: {
      topic: { type: 'string', default: 'fieldscope/test' },
      payload: { type: 'string', default: '' },
      qos: { type: 'enum', options: ['0', '1'], default: '0' },
      retain: { type: 'enum', options: ['no', 'retained'], default: 'no' },
      username: { type: 'string' },
      password: { type: 'string' },
    },
  },
};

const CONNACK_TEXT = {
  0: 'connection accepted',
  1: 'refused: unacceptable protocol version',
  2: 'refused: identifier rejected',
  3: 'refused: server unavailable',
  4: 'refused: bad user name or password',
  5: 'refused: not authorized',
};

// One bounded MQTT connection attempt. Resolves (never rejects) with either
// { client, connack, rttMs } or { failure } where failure feeds the rulepack:
// { connack_code } for a refusal, { timeout: true } for silence.
function mqttAttempt(ctx, { keepOpen = false } = {}) {
  const timeout = ctx.params?.timeout ?? 3000;
  const url = `mqtt://${ctx.host}:${ctx.port || 1883}`;
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let settled = false;
    const client = mqttlib.connect(url, {
      protocolVersion: 4,
      clientId: `fieldscope_${crypto.randomBytes(4).toString('hex')}`,
      connectTimeout: timeout,
      reconnectPeriod: 0,
      clean: true,
      resubscribe: false,
      username: ctx.params?.username || undefined,
      password: ctx.params?.password || undefined,
    });
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!out.client) client.end(true);
      resolve(out);
    };
    const timer = setTimeout(() => finish({ failure: { timeout: true } }), timeout + 500);
    client.once('connect', (connack) => {
      const rttMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (keepOpen) finish({ client, connack, rttMs });
      else {
        client.end(true);
        finish({ connack, rttMs });
      }
    });
    client.once('error', (err) => {
      // mqtt.js surfaces a CONNACK refusal as an error whose .code is the
      // return code (1–5); transport errors carry the usual ECONNREFUSED etc.
      if (typeof err.code === 'number') finish({ failure: { connack_code: err.code } });
      else if (/connack timeout/i.test(err.message || '')) finish({ failure: { timeout: true } });
      else finish({ failure: { error: err.code || err.message } });
    });
  });
}

// The rulepack wants transport separated from broker behavior, so probe TCP
// first — that is what distinguishes "port closed" from "broker refused us".
async function gatherFacts(ctx) {
  const timeout = ctx.params?.timeout ?? 3000;
  try {
    const { socket } = await tcpConnect(ctx.host, ctx.port || 1883, timeout);
    socket.destroy();
  } catch (err) {
    return {
      facts: {
        transport: { tcp_connect: 'fail', error: err.code || err.message },
        connack: { code: 'none' },
        timeout: err.code === 'ETIMEDOUT',
      },
    };
  }
  const attempt = await mqttAttempt(ctx);
  if (attempt.connack) {
    return {
      attempt,
      facts: {
        transport: { tcp_connect: 'success' },
        connack: { code: 0, code_text: CONNACK_TEXT[0], session_present: !!attempt.connack.sessionPresent },
        timeout: false,
        rtt_ms: attempt.rttMs,
      },
    };
  }
  const f = attempt.failure;
  return {
    attempt,
    facts: {
      transport: { tcp_connect: 'success' },
      connack:
        f.connack_code != null
          ? { code: f.connack_code, code_text: CONNACK_TEXT[f.connack_code] || `code ${f.connack_code}` }
          : { code: 'none', error: f.error },
      timeout: !!f.timeout,
    },
  };
}

function transcript(lines) {
  return lines.filter(Boolean).join('\n');
}

function preview(payload, max = 160) {
  const s = payload.toString('utf8').replace(/[^\x20-\x7e]/g, '.');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export const verbs = {
  async connect(ctx) {
    const { facts } = await gatherFacts(ctx);
    const ok = facts.connack.code === 0;
    return {
      artifact: makeArtifact({
        verb: 'connect',
        raw: transcript([
          `CONNECT mqtt://${ctx.host}:${ctx.port || 1883} protocol=3.1.1 clean=true`,
          ok
            ? `CONNACK rc=0 (accepted) session_present=${facts.connack.session_present} rtt=${facts.rtt_ms?.toFixed(1)}ms`
            : `no CONNACK: ${JSON.stringify(facts.connack)} timeout=${facts.timeout}`,
        ]),
        result: {
          connected: ok,
          connack: facts.connack,
          session_present: facts.connack.session_present ?? null,
          rtt_ms: facts.rtt_ms ?? null,
        },
      }),
      facts,
    };
  },

  async identify(ctx) {
    const { facts } = await gatherFacts(ctx);
    return {
      artifact: makeArtifact({
        verb: 'identify',
        raw: transcript([
          `CONNECT mqtt://${ctx.host}:${ctx.port || 1883}`,
          `CONNACK ${JSON.stringify(facts.connack)}`,
        ]),
        result: {
          broker_answering: facts.connack.code === 0,
          connack: facts.connack,
          rtt_ms: facts.rtt_ms ?? null,
        },
      }),
      facts,
    };
  },

  // Browse = bounded topic-tree sample: subscribe to the filter, collect for a
  // window, and render what is actually flowing (plus retained topics, which
  // arrive immediately on subscribe).
  async browse(ctx) {
    const filter = ctx.params?.filter || '#';
    const windowMs = Math.min(10000, Math.max(500, ctx.params?.window_ms ?? 2000));
    const attempt = await mqttAttempt(ctx, { keepOpen: true });
    if (!attempt.client) {
      return {
        artifact: makeArtifact({
          verb: 'browse',
          raw: `connect failed: ${JSON.stringify(attempt.failure)}`,
          result: { error: attempt.failure },
          error: new Error('MQTT connect failed'),
        }),
        facts: {},
      };
    }
    const topics = new Map();
    let total = 0;
    await new Promise((resolve) => {
      attempt.client.subscribe(filter, { qos: 0 }, () => {});
      attempt.client.on('message', (topic, payload, packet) => {
        total += 1;
        const t = topics.get(topic) || { count: 0, retained: false, last: null, bytes: 0 };
        t.count += 1;
        t.retained = t.retained || !!packet.retain;
        t.last = preview(payload);
        t.bytes = payload.length;
        topics.set(topic, t);
      });
      setTimeout(resolve, windowMs);
    });
    attempt.client.end(true);

    const points = [...topics.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([topic, t]) => ({
        ref: topic,
        value: t.last,
        type: `${t.count} msg${t.retained ? ' · retained' : ''} · ${t.bytes}B`,
      }));
    return {
      artifact: makeArtifact({
        verb: 'browse',
        raw: `SUBSCRIBE ${filter} for ${windowMs}ms → ${total} messages on ${topics.size} topics`,
        result: {
          tree: [{ area: `filter ${filter} (${windowMs}ms window)`, points }],
          topics: topics.size,
          messages: total,
        },
      }),
      facts: {},
    };
  },

  // Publish is the write verb — ARM-gated like any other write (§4.1). For a
  // retained publish the read-back subscribes and verifies the broker actually
  // stored the payload.
  async write(ctx) {
    if (!ctx.armed) {
      throw new Error('write refused: session not ARMED (double-gate, §4.1)');
    }
    const topic = ctx.params?.topic;
    if (!topic) throw new Error('publish requires a topic');
    const payload = String(ctx.params?.payload ?? '');
    const qos = Number(ctx.params?.qos ?? 0) === 1 ? 1 : 0;
    const retain = ctx.params?.retain === 'retained' || ctx.params?.retain === true;

    const attempt = await mqttAttempt(ctx, { keepOpen: true });
    if (!attempt.client) {
      throw new Error(`MQTT connect failed: ${JSON.stringify(attempt.failure)}`);
    }
    const ackMs = await new Promise((resolve, reject) => {
      const started = process.hrtime.bigint();
      attempt.client.publish(topic, payload, { qos, retain }, (err) =>
        err ? reject(err) : resolve(Number(process.hrtime.bigint() - started) / 1e6),
      );
    });

    // Read-back verification (§4.1): a retained publish must come back on a
    // fresh subscription with the same payload.
    let readBack = null;
    let verified = null;
    if (retain) {
      readBack = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 1500);
        attempt.client.subscribe(topic, { qos: 0 }, () => {});
        attempt.client.on('message', (t, p, packet) => {
          if (t === topic && packet.retain) {
            clearTimeout(timer);
            resolve(p.toString('utf8'));
          }
        });
      });
      verified = readBack === payload;
    }
    attempt.client.end(true);

    return {
      artifact: makeArtifact({
        verb: 'write',
        raw: transcript([
          `PUBLISH ${topic} qos=${qos} retain=${retain} (${payload.length}B)`,
          qos > 0 ? `PUBACK in ${ackMs.toFixed(1)}ms` : `sent in ${ackMs.toFixed(1)}ms`,
          retain ? `read-back: ${readBack === null ? 'no retained message' : preview(Buffer.from(readBack))}` : null,
        ]),
        result: {
          topic,
          published: payload,
          qos,
          retain,
          ack: true,
          read_back: readBack,
          verified,
          rtt_ms: ackMs,
        },
      }),
      facts: { write_ack: true },
      audit: {
        action: 'mqtt-publish',
        target: `${ctx.host}:${ctx.port || 1883}`,
        point: topic,
        after_value: payload,
        before_value: ctx.beforeValue ?? null,
      },
    };
  },

  // Monitor = broker responsiveness: full CONNECT→CONNACK round trip.
  async monitorSample(ctx) {
    const attempt = await mqttAttempt(ctx);
    if (attempt.connack) {
      return { value: attempt.rttMs, ok: true, raw: `CONNACK in ${attempt.rttMs.toFixed(1)}ms` };
    }
    return { value: null, ok: false, raw: `no CONNACK: ${JSON.stringify(attempt.failure)}` };
  },

  async diagnose(ctx) {
    const { facts } = await gatherFacts(ctx);
    return {
      facts,
      rulepack: 'mqtt',
      raw: transcript([
        `probe mqtt://${ctx.host}:${ctx.port || 1883}`,
        `tcp=${facts.transport.tcp_connect} connack=${JSON.stringify(facts.connack)} timeout=${facts.timeout}`,
      ]),
    };
  },
};
