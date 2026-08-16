// Config-backup workflow (§12 drift detection). A read-only diagnostics tool
// can't push a device's config back — but it can capture the readable state as a
// named baseline and tell you, in plain English, exactly what drifted since.
//
// A backup is a *normalized snapshot*: the driver's identity fields plus every
// point the read/browse verbs surface, flattened into a stable, sorted list of
// { key, point, value, type } entries. Normalization is what makes it diffable
// across protocols — the same shape whether the points came from Modbus holding
// registers, a BACnet object-list, or an OPC UA endpoint enumeration.
//
// Capture drives the driver through its own read-oriented verbs (identify →
// browse → any explicit reads), so one call produces a complete artifact-backed
// snapshot. Drift diff aligns two snapshots by point key and classifies each as
// added / removed / changed / unchanged, with a severity a rulepack-style
// verdict can render.

// Pull a flat, stable point list out of the artifacts a capture produced.
// Sources, in order of precedence (later overrides earlier on key collision):
//   1. identify — scalar result fields become `identity/<field>` points
//   2. browse / read — every `result.tree[].points[]` entry
export function normalizeSnapshot(artifacts) {
  const byKey = new Map();
  const put = (group, ref, value, type) => {
    if (value === undefined) return;
    const key = `${group}/${ref}`;
    byKey.set(key, { key, group, point: ref, value: normalizeValue(value), type: type || null });
  };

  for (const art of artifacts) {
    if (!art) continue;
    const result = art.result || {};
    if (art.verb === 'identify') {
      for (const [field, value] of Object.entries(result)) {
        if (isScalar(value) && !TRANSIENT.has(field)) put('identity', field, value, 'identity');
      }
    }
    const tree = result.tree;
    if (Array.isArray(tree)) {
      for (const area of tree) {
        const group = area.area || 'points';
        for (const p of area.points || []) {
          put(group, p.ref ?? String(p.address ?? ''), p.value, p.type);
        }
      }
    }
  }

  const points = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { points, captured_verbs: artifacts.filter(Boolean).map((a) => a.verb) };
}

// Runtime-transient identity fields that are not configuration and would create
// false drift on every capture (latencies, timestamps, liveness echoes).
const TRANSIENT = new Set(['rtt_ms', 'connect_ms', 'handshake_ms', 'timestamp', 'ts', 'modbus_responding', 'acknowledged']);

function isScalar(v) {
  return v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

// Round floats so imperceptible last-bit noise doesn't register as drift.
function normalizeValue(v) {
  if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v * 1000) / 1000;
  return v;
}

// Drive a driver through its read-oriented verbs and store the snapshot. `reads`
// is an optional list of param-sets run through the `read` verb and merged in
// (e.g. specific Modbus register blocks with a byte order).
export async function captureConfig(orchestrator, store, sessionId, { name, reads = [] } = {}) {
  const rt = orchestrator.getSession(sessionId);
  const driver = orchestrator.registry.get(rt.driverId);
  const has = (v) => driver.manifest.verbs.includes(v) && driver.verbs[v];
  const artifacts = [];

  if (has('identify')) artifacts.push(safe(await tryVerb(orchestrator, sessionId, 'identify', {})));
  if (has('browse')) artifacts.push(safe(await tryVerb(orchestrator, sessionId, 'browse', {})));
  if (has('read')) {
    for (const r of reads) artifacts.push(safe(await tryVerb(orchestrator, sessionId, 'read', r)));
  }

  const snapshot = normalizeSnapshot(artifacts.filter(Boolean));
  const row = store.saveBackup({
    session_id: sessionId,
    driver_id: rt.driverId,
    name: name || `${rt.driverId} backup`,
    address: rt.port ? `${rt.host}:${rt.port}` : rt.host,
    snapshot,
  });
  return { backup: row, artifacts: artifacts.filter(Boolean).map((a) => a.id) };
}

async function tryVerb(orchestrator, sessionId, verb, params) {
  try {
    return await orchestrator.runVerb(sessionId, verb, params);
  } catch {
    return null;
  }
}

function safe(a) {
  return a || null;
}

// Diff two snapshots by point key. Returns per-point rows plus a summary and an
// overall severity: `ok` when nothing drifted, `warn` when values changed or
// points appeared/disappeared.
export function diffSnapshots(baseSnap, currSnap) {
  const base = new Map((baseSnap.points || []).map((p) => [p.key, p]));
  const curr = new Map((currSnap.points || []).map((p) => [p.key, p]));
  const rows = [];
  let changed = 0;
  let added = 0;
  let removed = 0;
  let unchanged = 0;

  const keys = [...new Set([...base.keys(), ...curr.keys()])].sort();
  for (const key of keys) {
    const b = base.get(key);
    const c = curr.get(key);
    if (b && c) {
      const same = eq(b.value, c.value);
      rows.push({ key, group: b.group, point: b.point, type: b.type, status: same ? 'unchanged' : 'changed', before: b.value, after: c.value });
      if (same) unchanged += 1; else changed += 1;
    } else if (b) {
      rows.push({ key, group: b.group, point: b.point, type: b.type, status: 'removed', before: b.value, after: null });
      removed += 1;
    } else {
      rows.push({ key, group: c.group, point: c.point, type: c.type, status: 'added', before: null, after: c.value });
      added += 1;
    }
  }

  const drifted = changed + added + removed;
  return {
    summary: { total: rows.length, unchanged, changed, added, removed, drifted },
    severity: drifted ? 'warn' : 'ok',
    title: drifted
      ? `Config drift: ${drifted} point(s) differ from baseline (${changed} changed, ${added} new, ${removed} gone)`
      : 'No config drift — every point matches the baseline',
    rows,
  };
}

function eq(a, b) {
  return String(a) === String(b);
}
