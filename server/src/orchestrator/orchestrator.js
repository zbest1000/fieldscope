// Session orchestrator (§3). Sits between UI intent and the drivers:
// - manages sessions and the ARM state machine (§4.1, Gate 1)
// - enforces the rate budget (bounded by design, §2)
// - dispatches verbs to drivers, annotates results with verdicts via the rules
//   engine, and persists every Artifact to the evidence store
// - runs Monitor loops with cancellation
//
// The double-gate lives here: ARM is a session-level toggle that auto-expires;
// the per-write confirm (Gate 2) is enforced at the API layer, which requires a
// matching confirmation token before it calls executeWrite().

import crypto from 'node:crypto';

const ARM_TIMEOUT_MS = 5 * 60 * 1000; // auto-expire ARM after inactivity (§4.1)
const DEFAULT_RATE = { capacity: 20, refillPerSec: 10 };

export class Orchestrator {
  constructor({ registry, store, rules, emit }) {
    this.registry = registry;
    this.store = store;
    this.rules = rules;
    this.emit = emit || (() => {});
    this.sessions = new Map(); // sessionId -> runtime state
    this.monitors = new Map(); // monitorId -> { timer, ... }
  }

  // ---- sessions ------------------------------------------------------------
  openSession({ driverId, host, port, unitId, targetId, operator, sourceAdapter, vlan }) {
    const driver = this.registry.get(driverId);
    if (!driver) throw new Error(`unknown driver ${driverId}`);
    const row = this.store.createSession({
      driver_id: driverId,
      target_id: targetId,
      address: port ? `${host}:${port}` : host,
      operator,
      source_adapter: sourceAdapter,
      vlan,
      arm_state: 'READ-ONLY',
    });
    this.sessions.set(row.id, {
      id: row.id,
      driverId,
      host,
      port,
      unitId: unitId ?? 1,
      armed: false,
      armExpires: 0,
      rate: { ...DEFAULT_RATE, tokens: DEFAULT_RATE.capacity, last: nowMs() },
      pendingWrites: new Map(),
    });
    return row;
  }

  getSession(id) {
    const rt = this.sessions.get(id);
    if (!rt) throw new Error(`session ${id} not open`);
    // ARM auto-expiry check on every access (§4.1).
    if (rt.armed && nowMs() > rt.armExpires) {
      rt.armed = false;
      this.emit('arm', { sessionId: id, armed: false, reason: 'auto-expired' });
    }
    return rt;
  }

  closeSession(id) {
    this.stopMonitorsForSession(id);
    this.store.endSession(id);
    this.sessions.delete(id);
  }

  // ---- ARM (Gate 1) --------------------------------------------------------
  arm(sessionId, confirmText) {
    const rt = this.getSession(sessionId);
    if (confirmText !== 'ARM') {
      throw new Error('ARM requires typed confirmation "ARM" (not a stray click)');
    }
    const driver = this.registry.get(rt.driverId);
    if (!driver.manifest.write_capable) {
      throw new Error(`${rt.driverId} is not write-capable; nothing to arm`);
    }
    rt.armed = true;
    rt.armExpires = nowMs() + ARM_TIMEOUT_MS;
    this.emit('arm', { sessionId, armed: true, expiresInMs: ARM_TIMEOUT_MS });
    this.store.recordAudit({ session_id: sessionId, action: 'arm', confirmation: 'ARM' });
    return { armed: true, expiresInMs: ARM_TIMEOUT_MS };
  }

  disarm(sessionId) {
    const rt = this.getSession(sessionId);
    rt.armed = false;
    this.emit('arm', { sessionId, armed: false, reason: 'manual' });
    this.store.recordAudit({ session_id: sessionId, action: 'disarm' });
    return { armed: false };
  }

  // ---- rate limiting (token bucket) ---------------------------------------
  #spendToken(rt) {
    const now = nowMs();
    const elapsed = (now - rt.rate.last) / 1000;
    rt.rate.tokens = Math.min(rt.rate.capacity, rt.rate.tokens + elapsed * rt.rate.refillPerSec);
    rt.rate.last = now;
    if (rt.rate.tokens < 1) {
      throw new Error('rate budget exceeded — probe cadence is bounded by design (§2)');
    }
    rt.rate.tokens -= 1;
  }

  // ---- verb dispatch -------------------------------------------------------
  async runVerb(sessionId, verb, params = {}) {
    const rt = this.getSession(sessionId);
    const driver = this.registry.get(rt.driverId);
    if (!driver.manifest.verbs.includes(verb)) {
      throw new Error(`${rt.driverId} does not implement ${verb}`);
    }
    if (verb === 'write') {
      throw new Error('writes must go through prepareWrite() + confirmWrite() (double-gate)');
    }
    this.#spendToken(rt);

    const ctx = this.#ctx(rt, params);
    const fn = driver.verbs[verb];
    if (!fn) throw new Error(`${rt.driverId}.${verb} not available`);

    const out = await fn(ctx);
    return this.#persist(rt, driver, verb, out, ctx);
  }

  // Diagnose runs the driver's diagnose(), then the matching rulepack, and
  // attaches the resulting verdicts to a synthesized artifact.
  async diagnose(sessionId, params = {}) {
    const rt = this.getSession(sessionId);
    const driver = this.registry.get(rt.driverId);
    if (!driver.verbs.diagnose) throw new Error(`${rt.driverId} has no diagnose verb`);
    this.#spendToken(rt);
    const ctx = this.#ctx(rt, params);
    const res = await driver.verbs.diagnose(ctx);
    const verdicts = res.rulepack ? this.rules.evaluate(res.rulepack, res.facts) : [];
    // Pass structured raw (e.g. Modbus { tx, rx } hex) through untouched; wrap a
    // plain string transcript as text.
    let raw = null;
    if (res.raw) raw = typeof res.raw === 'string' ? { text: res.raw } : res.raw;
    const artifact = {
      verb: 'diagnose',
      raw,
      decode: res.decode || null,
      result: { facts: res.facts, rulepack: res.rulepack },
      verdicts,
    };
    const saved = this.store.saveArtifact(sessionId, rt.driverId, artifact, null);
    this.emit('artifact', { sessionId, artifact: saved });
    return saved;
  }

  // ---- write path: prepare (dry-run) → confirm (Gate 2) → execute ---------
  // prepareWrite composes the write and returns the exact bytes + decode WITHOUT
  // sending (§4.1 dry-run/preview), plus a one-time confirmation token.
  async prepareWrite(sessionId, params) {
    const rt = this.getSession(sessionId);
    const driver = this.registry.get(rt.driverId);
    if (!driver.manifest.write_capable) throw new Error(`${rt.driverId} is not write-capable`);

    // Read current value first so the confirm shows current → proposed (§4.1).
    let currentValue = null;
    try {
      const readArea = params.area === 'coil' ? 'coils' : 'holding';
      const ctx = this.#ctx(rt, { ...params, area: readArea, count: 1 });
      if (driver.verbs.read) {
        const r = await driver.verbs.read(ctx);
        currentValue = r.artifact?.result?.values ? r.artifact.result.values[0] : null;
      }
    } catch {
      currentValue = null;
    }

    const token = crypto.randomBytes(8).toString('hex');
    rt.pendingWrites.set(token, { params, currentValue, created: nowMs() });
    return {
      token,
      target: rt.port ? `${rt.host}:${rt.port}` : rt.host,
      point: `${params.area ?? 'holding'}:${params.address ?? 0}`,
      current_value: currentValue,
      proposed_value: params.value,
      requires_arm: true,
      armed: rt.armed,
    };
  }

  // confirmWrite is Gate 2: it requires (a) the session ARMED and (b) the
  // one-time token from prepareWrite. Only then does it call the driver's write.
  async confirmWrite(sessionId, token) {
    const rt = this.getSession(sessionId);
    if (!rt.armed) throw new Error('write blocked: session is not ARMED (Gate 1)');
    const pending = rt.pendingWrites.get(token);
    if (!pending) throw new Error('write blocked: no matching prepared write (Gate 2)');
    rt.pendingWrites.delete(token);
    rt.armExpires = nowMs() + ARM_TIMEOUT_MS; // activity refreshes ARM

    const driver = this.registry.get(rt.driverId);
    this.#spendToken(rt);
    const ctx = this.#ctx(rt, pending.params, { armed: true, beforeValue: pending.currentValue });
    const out = await driver.verbs.write(ctx);
    const saved = this.#persist(rt, driver, 'write', out, ctx);

    // Mandatory audit (§4.1, non-disableable).
    if (out.audit) {
      this.store.recordAudit({
        session_id: sessionId,
        artifact_id: saved.id,
        action: out.audit.action,
        target: out.audit.target,
        point: out.audit.point,
        before_value: pending.currentValue,
        after_value: out.audit.after_value,
        confirmation: `token:${token}`,
      });
    }
    return saved;
  }

  // ---- monitor -------------------------------------------------------------
  startMonitor(sessionId, params = {}) {
    const rt = this.getSession(sessionId);
    const driver = this.registry.get(rt.driverId);
    if (!driver.verbs.monitorSample) throw new Error(`${rt.driverId} has no monitor`);
    const cadence = Math.max(250, params.cadence ?? 1000);
    const monitorId = `mon_${crypto.randomBytes(4).toString('hex')}`;
    const stats = { count: 0, ok: 0, min: Infinity, max: -Infinity, sum: 0, samples: [] };

    const tick = async () => {
      try {
        const ctx = this.#ctx(rt, params);
        const s = await driver.verbs.monitorSample(ctx);
        stats.count += 1;
        if (s.ok) stats.ok += 1;
        if (typeof s.value === 'number') {
          stats.min = Math.min(stats.min, s.value);
          stats.max = Math.max(stats.max, s.value);
          stats.sum += s.value;
        }
        stats.samples.push({ t: nowMs(), value: s.value, ok: s.ok });
        if (stats.samples.length > 120) stats.samples.shift();
        const jitter = stddev(stats.samples.filter((x) => typeof x.value === 'number').map((x) => x.value));
        this.emit('monitor', {
          monitorId,
          sessionId,
          sample: { value: s.value, ok: s.ok },
          stats: {
            count: stats.count,
            loss_pct: Math.round(((stats.count - stats.ok) / stats.count) * 100),
            min: isFinite(stats.min) ? stats.min : null,
            max: isFinite(stats.max) ? stats.max : null,
            avg: stats.count ? stats.sum / Math.max(1, stats.ok) : null,
            jitter,
          },
          series: stats.samples.map((x) => x.value),
        });
      } catch (err) {
        this.emit('monitor', { monitorId, sessionId, error: err.message });
      }
    };

    const timer = setInterval(tick, cadence);
    this.monitors.set(monitorId, { timer, sessionId });
    tick();
    return { monitorId, cadence };
  }

  stopMonitor(monitorId) {
    const m = this.monitors.get(monitorId);
    if (m) {
      clearInterval(m.timer);
      this.monitors.delete(monitorId);
    }
    return { stopped: true };
  }

  stopMonitorsForSession(sessionId) {
    for (const [id, m] of this.monitors) {
      if (m.sessionId === sessionId) {
        clearInterval(m.timer);
        this.monitors.delete(id);
      }
    }
  }

  // ---- helpers -------------------------------------------------------------
  #ctx(rt, params, extra = {}) {
    return {
      sessionId: rt.id,
      host: rt.host,
      port: rt.port,
      unitId: rt.unitId,
      armed: rt.armed,
      params: params || {},
      ...extra,
    };
  }

  #persist(rt, driver, verb, out, ctx) {
    const artifact = out.artifact;
    // Attach rulepack verdicts if the verb produced facts but no verdicts and a
    // rulepack exists named after the driver.
    if (artifact && (!artifact.verdicts || artifact.verdicts.length === 0) && out.facts && this.rules.packs.has(rt.driverId)) {
      const verdicts = this.rules.evaluate(rt.driverId, out.facts);
      if (verdicts.length) artifact.verdicts = verdicts;
    }
    const rawBuffer = ctx?._rawBuffer || null;
    const saved = this.store.saveArtifact(rt.id, rt.driverId, artifact, rawBuffer);
    this.emit('artifact', { sessionId: rt.id, artifact: saved });
    return saved;
  }
}

function stddev(xs) {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

function nowMs() {
  return Date.now();
}
