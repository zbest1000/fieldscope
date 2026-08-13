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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5100;
const DATA_DIR = process.env.FIELDSCOPE_DATA || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const registry = new DriverRegistry();
const store = new EvidenceStore({ dir: DATA_DIR });
const rules = new RulesEngine({ dir: path.join(__dirname, 'rulepacks') });

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: '*' } });

const orchestrator = new Orchestrator({
  registry,
  store,
  rules,
  emit: (event, payload) => io.emit(event, payload),
});

// ---- helpers ---------------------------------------------------------------
const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    res.json(out ?? { ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// ---- meta ------------------------------------------------------------------
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'fieldscope', version: '0.1.0' }));

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

export { app, orchestrator, registry, store, rules };
