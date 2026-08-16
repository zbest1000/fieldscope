// Fieldscope backend entry point. Wires the registry, evidence store, rules
// engine, and orchestrator behind a small REST + Socket.IO API. The frontend is
// a thin renderer over this — all protocol logic lives server-side.

import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { Server as SocketServer } from 'socket.io';

import { DriverRegistry } from './src/drivers/index.js';
import { EvidenceStore } from './src/evidence/store.js';
import { RulesEngine } from './src/rules/engine.js';
import { Orchestrator } from './src/orchestrator/orchestrator.js';
import { renderSessionReport, toInventoryCsv } from './src/report/report.js';
import { captureConfig, diffSnapshots, recheckBaseline, DriftWatcher } from './src/backup/backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5100;
const DATA_DIR = process.env.FIELDSCOPE_DATA || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const registry = new DriverRegistry();
const store = new EvidenceStore({ dir: DATA_DIR });
const rules = new RulesEngine({ dir: path.join(__dirname, 'rulepacks') });

const app = express();
app.use(express.json());

// Minimal request log for API calls — enough to follow a session from the
// container logs without a logging framework.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`[api] ${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
});

const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: '*' } });

const orchestrator = new Orchestrator({
  registry,
  store,
  rules,
  emit: (event, payload) => io.emit(event, payload),
});

const driftWatcher = new DriftWatcher({ orchestrator, store, emit: (event, payload) => io.emit(event, payload) });

// ---- helpers ---------------------------------------------------------------
const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    res.json(out ?? { ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const slug = (s) => String(s || 'baseline').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'baseline';

// ---- meta ------------------------------------------------------------------
app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    service: 'fieldscope',
    version: '0.2.0',
    uptime_s: Math.round(process.uptime()),
    drivers: registry.list().length,
    rulepacks: rules.listPacks().length,
  }));

app.get('/api/drivers', (_req, res) => res.json({ drivers: registry.list(), grouped: registry.grouped() }));
app.get('/api/drivers/:id', (req, res) => {
  const m = registry.manifest(req.params.id);
  if (!m) return res.status(404).json({ error: 'unknown driver' });
  res.json(m);
});
app.get('/api/rulepacks', (_req, res) => res.json({ packs: rules.listPacks() }));
app.post('/api/rulepacks/reload', wrap(async () => ({ loaded: rules.load() })));

// ---- targets ---------------------------------------------------------------
app.get('/api/targets', (_req, res) => res.json({ targets: store.listTargets() }));
app.post('/api/targets', wrap(async (req) => store.saveTarget(req.body)));
app.delete('/api/targets/:id', wrap(async (req) => {
  store.deleteTarget(req.params.id);
  return { deleted: req.params.id };
}));

// ---- sessions --------------------------------------------------------------
app.post('/api/sessions', wrap(async (req) => orchestrator.openSession(req.body)));
app.get('/api/sessions', (_req, res) => res.json({ sessions: store.listSessions() }));
app.get('/api/sessions/:id/artifacts', (req, res) =>
  res.json({ artifacts: store.listArtifacts(req.params.id) }));
app.post('/api/sessions/:id/close', wrap(async (req) => {
  orchestrator.closeSession(req.params.id);
  return { closed: req.params.id };
}));

// ---- verbs -----------------------------------------------------------------
app.post('/api/sessions/:id/verb/:verb', wrap(async (req) =>
  orchestrator.runVerb(req.params.id, req.params.verb, req.body?.params || {})));

app.post('/api/sessions/:id/diagnose', wrap(async (req) =>
  orchestrator.diagnose(req.params.id, req.body?.params || {})));

// ---- write path (double-gate, §4.1) ---------------------------------------
app.post('/api/sessions/:id/arm', wrap(async (req) =>
  orchestrator.arm(req.params.id, req.body?.confirm)));
app.post('/api/sessions/:id/disarm', wrap(async (req) => orchestrator.disarm(req.params.id)));
app.post('/api/sessions/:id/write/prepare', wrap(async (req) =>
  orchestrator.prepareWrite(req.params.id, req.body?.params || {})));
app.post('/api/sessions/:id/write/confirm', wrap(async (req) =>
  orchestrator.confirmWrite(req.params.id, req.body?.token)));

// ---- monitor ---------------------------------------------------------------
app.post('/api/sessions/:id/monitor/start', wrap(async (req) =>
  orchestrator.startMonitor(req.params.id, req.body?.params || {})));
app.post('/api/monitor/:monitorId/stop', wrap(async (req) =>
  orchestrator.stopMonitor(req.params.monitorId)));

// ---- evidence: raw, replay, diff, audit ------------------------------------
app.get('/api/artifacts/:id/raw', (req, res) => {
  const blob = store.readBlob(req.params.id);
  if (!blob) return res.status(404).json({ error: 'no raw blob' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(blob);
});
app.get('/api/sessions/:id/replay', (req, res) => res.json({ artifacts: store.replay(req.params.id) }));
app.get('/api/diff', (req, res) => {
  const { a, b } = req.query;
  if (!a || !b) return res.status(400).json({ error: 'need ?a= and ?b= session ids' });
  res.json({ rows: store.diff(a, b) });
});
app.get('/api/audit', (_req, res) => res.json({ entries: store.listAudit() }));

// ---- config backups & drift detection --------------------------------------
// Capture a device's readable configuration as a named baseline (drives the
// driver's identify/browse/read verbs and normalizes the result into a stable,
// diffable point list), list baselines, and diff any two for drift.
app.post('/api/sessions/:id/backup', wrap(async (req) =>
  captureConfig(orchestrator, store, req.params.id, { name: req.body?.name, reads: req.body?.reads || [] })));
app.get('/api/backups', (_req, res) => res.json({ backups: store.listBackups() }));
app.get('/api/backups/:id', (req, res) => {
  const b = store.getBackup(req.params.id);
  if (!b) return res.status(404).json({ error: 'unknown backup' });
  res.json(b);
});
// Export a baseline as a portable JSON file (archive / hand off / diff offline).
app.get('/api/backups/:id/export', (req, res) => {
  const b = store.getBackup(req.params.id);
  if (!b) return res.status(404).json({ error: 'unknown backup' });
  const doc = { fieldscope_backup: 1, name: b.name, driver_id: b.driver_id, address: b.address, created_at: b.created_at, point_count: b.point_count, snapshot: b.snapshot };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fieldscope-baseline-${slug(b.name)}.json"`);
  res.send(JSON.stringify(doc, null, 2));
});
// Re-import a previously exported baseline JSON as a new baseline.
app.post('/api/backups/import', wrap(async (req) => {
  const doc = req.body || {};
  if (!doc.snapshot || !Array.isArray(doc.snapshot.points)) throw new Error('not a Fieldscope baseline export (missing snapshot.points)');
  return store.saveBackup({
    driver_id: doc.driver_id || 'imported',
    name: doc.name ? `${doc.name} (imported)` : 'imported baseline',
    address: doc.address || '',
    snapshot: doc.snapshot,
  });
}));
app.delete('/api/backups/:id', wrap(async (req) => {
  store.deleteBackup(req.params.id);
  return { deleted: req.params.id };
}));
// Drift diff: ?a=<baselineId>&b=<baselineId>, or capture-and-compare when b is a
// live session (b=session:<sessionId>).
app.get('/api/backups/diff', wrap(async (req) => {
  const { a, b } = req.query;
  const base = store.getBackup(a);
  if (!base) throw new Error('unknown baseline (a)');
  let curr;
  if (typeof b === 'string' && b.startsWith('session:')) {
    const cap = await captureConfig(orchestrator, store, b.slice('session:'.length), { name: `drift-check vs ${base.name}` });
    curr = cap.backup;
  } else {
    curr = store.getBackup(b);
  }
  if (!curr) throw new Error('unknown comparison snapshot (b)');
  return { baseline: { id: base.id, name: base.name }, current: { id: curr.id, name: curr.name }, ...diffSnapshots(base.snapshot, curr.snapshot) };
}));
// One-shot recheck: re-capture the baseline's device and report drift now.
app.post('/api/backups/:id/recheck', wrap(async (req) =>
  recheckBaseline(orchestrator, store, req.params.id, { reads: req.body?.reads || [], keep: !!req.body?.keep })));
// Drift watch: periodically recheck and emit a `drift` socket event on change.
app.post('/api/backups/:id/watch', wrap(async (req) => driftWatcher.start(req.params.id, req.body?.interval_s ?? 300)));
app.delete('/api/backups/:id/watch', wrap(async (req) => driftWatcher.stop(req.params.id)));
app.get('/api/backups/watches', (_req, res) => res.json({ watches: driftWatcher.list() }));

// ---- reports (§12 phase 8) -------------------------------------------------
// A self-contained, print-friendly HTML commissioning report for one session:
// findings first, then the artifact timeline and the write/ARM audit trail.
// Credentials are redacted server-side before anything leaves the store.
app.get('/api/sessions/:id/report', (req, res) => {
  const session = store.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'unknown session' });
  const html = renderSessionReport({
    session,
    artifacts: store.listArtifacts(req.params.id),
    audit: store.listAudit(),
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Point/object inventory as CSV — the commissioning point-list export.
app.get('/api/sessions/:id/inventory.csv', (req, res) => {
  const session = store.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'unknown session' });
  const csv = toInventoryCsv(session, store.listArtifacts(req.params.id));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fieldscope-inventory-${req.params.id}.csv"`);
  res.send(csv);
});

// ---- static client (production) --------------------------------------------
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

server.listen(PORT, () => {
  console.log(`[fieldscope] backend on http://localhost:${PORT}`);
  console.log(`[fieldscope] drivers: ${registry.list().map((d) => d.id).join(', ')}`);
  console.log(`[fieldscope] rulepacks: ${rules.listPacks().map((p) => p.rulepack).join(', ')}`);
});

// Graceful shutdown: stop monitors, flush SQLite, close sockets. Docker sends
// SIGTERM on `docker stop`; without this the WAL can be left mid-checkpoint.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[fieldscope] ${signal} — shutting down`);
  for (const [id] of orchestrator.monitors) orchestrator.stopMonitor(id);
  driftWatcher.stopAll();
  io.close();
  server.closeIdleConnections?.(); // don't let a parked keep-alive hold the exit
  server.close(() => {
    try { store.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  // Hard exit if a socket refuses to drain.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app, orchestrator, registry, store, rules };
