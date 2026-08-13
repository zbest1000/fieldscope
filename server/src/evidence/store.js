// Evidence store (§9). SQLite for structured metadata/results (queryable,
// diffable); flat blob files for raw byte streams (referenced by path from
// SQLite). This keeps the DB small and captures portable.
//
// The store is written once and serves every driver — that uniformity is the
// whole point of the Artifact shape in the contract.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class EvidenceStore {
  constructor({ dir }) {
    this.dir = dir;
    this.blobDir = path.join(dir, 'blobs');
    fs.mkdirSync(this.blobDir, { recursive: true });
    this.db = new Database(path.join(dir, 'fieldscope.db'));
    this.db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS target (
        id TEXT PRIMARY KEY,
        name TEXT,
        address TEXT,
        protocol TEXT,
        notes TEXT,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        target_id TEXT,
        driver_id TEXT,
        address TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        operator TEXT,
        arm_state TEXT,
        source_adapter TEXT,
        vlan TEXT,
        clock_anchor TEXT
      );
      CREATE TABLE IF NOT EXISTS artifact (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        driver_id TEXT,
        verb TEXT,
        timestamp_ptp INTEGER,
        seq INTEGER,
        raw_ref TEXT,
        raw_summary TEXT,
        decode TEXT,
        result TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS verdict (
        id TEXT PRIMARY KEY,
        artifact_id TEXT,
        rule_id TEXT,
        severity TEXT,
        title TEXT,
        detail TEXT,
        next_steps TEXT
      );
      CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        artifact_id TEXT,
        operator TEXT,
        timestamp INTEGER,
        action TEXT,
        target TEXT,
        point TEXT,
        before_value TEXT,
        after_value TEXT,
        confirmation TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_artifact_session ON artifact(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_verdict_artifact ON verdict(artifact_id);
    `);
  }

  // ---- targets -------------------------------------------------------------
  saveTarget(t) {
    const id = t.id || uid('tgt');
    this.db
      .prepare(
        `INSERT INTO target (id,name,address,protocol,notes,created_at)
         VALUES (@id,@name,@address,@protocol,@notes,@created_at)
         ON CONFLICT(id) DO UPDATE SET name=@name,address=@address,protocol=@protocol,notes=@notes`,
      )
      .run({
        id,
        name: t.name || t.address,
        address: t.address,
        protocol: t.protocol,
        notes: t.notes || '',
        created_at: t.created_at || now(),
      });
    return this.getTarget(id);
  }

  getTarget(id) {
    return this.db.prepare('SELECT * FROM target WHERE id=?').get(id);
  }

  listTargets() {
    return this.db.prepare('SELECT * FROM target ORDER BY created_at DESC').all();
  }

  deleteTarget(id) {
    this.db.prepare('DELETE FROM target WHERE id=?').run(id);
  }

  // ---- sessions ------------------------------------------------------------
  createSession(s) {
    const id = s.id || uid('ses');
    this.db
      .prepare(
        `INSERT INTO session
         (id,target_id,driver_id,address,started_at,ended_at,operator,arm_state,source_adapter,vlan,clock_anchor)
         VALUES (@id,@target_id,@driver_id,@address,@started_at,NULL,@operator,@arm_state,@source_adapter,@vlan,@clock_anchor)`,
      )
      .run({
        id,
        target_id: s.target_id || null,
        driver_id: s.driver_id,
        address: s.address || '',
        started_at: now(),
        operator: s.operator || 'engineer',
        arm_state: s.arm_state || 'READ-ONLY',
        source_adapter: s.source_adapter || 'default',
        vlan: s.vlan || null,
        clock_anchor: s.clock_anchor || 'system',
      });
    return this.getSession(id);
  }

  endSession(id) {
    this.db.prepare('UPDATE session SET ended_at=? WHERE id=?').run(now(), id);
  }

  getSession(id) {
    return this.db.prepare('SELECT * FROM session WHERE id=?').get(id);
  }

  listSessions(limit = 100) {
    return this.db
      .prepare('SELECT * FROM session ORDER BY started_at DESC LIMIT ?')
      .all(limit);
  }

  // ---- artifacts -----------------------------------------------------------
  // Persist one Artifact (the atomic unit, one per verb call). Raw bytes go to a
  // blob file; everything else to SQLite. Attached verdicts persist too.
  saveArtifact(sessionId, driverId, artifact, rawBuffer) {
    const id = uid('art');
    const seq =
      (this.db
        .prepare('SELECT COALESCE(MAX(seq),0) AS m FROM artifact WHERE session_id=?')
        .get(sessionId).m || 0) + 1;

    let rawRef = null;
    if (rawBuffer && rawBuffer.length) {
      const fname = `${id}.bin`;
      fs.writeFileSync(path.join(this.blobDir, fname), rawBuffer);
      rawRef = fname;
    }

    this.db
      .prepare(
        `INSERT INTO artifact
         (id,session_id,driver_id,verb,timestamp_ptp,seq,raw_ref,raw_summary,decode,result,error)
         VALUES (@id,@session_id,@driver_id,@verb,@ts,@seq,@raw_ref,@raw_summary,@decode,@result,@error)`,
      )
      .run({
        id,
        session_id: sessionId,
        driver_id: driverId,
        verb: artifact.verb,
        ts: now(),
        seq,
        raw_ref: rawRef,
        raw_summary: artifact.raw ? JSON.stringify(artifact.raw) : null,
        decode: artifact.decode ? JSON.stringify(artifact.decode) : null,
        result: artifact.result ? JSON.stringify(artifact.result) : null,
        error: artifact.error || null,
      });

    const verdictRows = [];
    for (const v of artifact.verdicts || []) {
      const vid = uid('vdt');
      this.db
        .prepare(
          `INSERT INTO verdict (id,artifact_id,rule_id,severity,title,detail,next_steps)
           VALUES (@id,@artifact_id,@rule_id,@severity,@title,@detail,@next_steps)`,
        )
        .run({
          id: vid,
          artifact_id: id,
          rule_id: v.rule_id || v.id || null,
          severity: v.severity || 'info',
          title: v.title || '',
          detail: v.detail || '',
          next_steps: JSON.stringify(v.next_steps || []),
        });
      verdictRows.push({ id: vid, ...v });
    }

    return this.getArtifact(id);
  }

  getArtifact(id) {
    const row = this.db.prepare('SELECT * FROM artifact WHERE id=?').get(id);
    if (!row) return null;
    return this.#hydrateArtifact(row);
  }

  listArtifacts(sessionId) {
    const rows = this.db
      .prepare('SELECT * FROM artifact WHERE session_id=? ORDER BY seq ASC')
      .all(sessionId);
    return rows.map((r) => this.#hydrateArtifact(r));
  }

  readBlob(artifactId) {
    const row = this.db.prepare('SELECT raw_ref FROM artifact WHERE id=?').get(artifactId);
    if (!row || !row.raw_ref) return null;
    const p = path.join(this.blobDir, row.raw_ref);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }

  #hydrateArtifact(row) {
    const verdicts = this.db
      .prepare('SELECT * FROM verdict WHERE artifact_id=?')
      .all(row.id)
      .map((v) => ({
        id: v.id,
        rule_id: v.rule_id,
        severity: v.severity,
        title: v.title,
        detail: v.detail,
        next_steps: safeParse(v.next_steps, []),
      }));
    return {
      id: row.id,
      session_id: row.session_id,
      driver_id: row.driver_id,
      verb: row.verb,
      timestamp_ptp: row.timestamp_ptp,
      seq: row.seq,
      has_raw: !!row.raw_ref,
      raw: safeParse(row.raw_summary, null),
      decode: safeParse(row.decode, null),
      result: safeParse(row.result, null),
      error: row.error,
      verdicts,
    };
  }

  // ---- audit (§4.1, non-disableable) --------------------------------------
  recordAudit(entry) {
    const id = uid('aud');
    this.db
      .prepare(
        `INSERT INTO audit
         (id,session_id,artifact_id,operator,timestamp,action,target,point,before_value,after_value,confirmation)
         VALUES (@id,@session_id,@artifact_id,@operator,@timestamp,@action,@target,@point,@before_value,@after_value,@confirmation)`,
      )
      .run({
        id,
        session_id: entry.session_id || null,
        artifact_id: entry.artifact_id || null,
        operator: entry.operator || 'engineer',
        timestamp: now(),
        action: entry.action,
        target: entry.target || '',
        point: entry.point || '',
        before_value: stringifyMaybe(entry.before_value),
        after_value: stringifyMaybe(entry.after_value),
        confirmation: entry.confirmation || '',
      });
    return id;
  }

  listAudit(limit = 200) {
    return this.db.prepare('SELECT * FROM audit ORDER BY timestamp DESC LIMIT ?').all(limit);
  }

  // ---- replay & diff (§9) --------------------------------------------------
  // Replay re-streams a session's artifacts in timeline order.
  replay(sessionId) {
    return this.listArtifacts(sessionId);
  }

  // Diff aligns two sessions by (verb + driver) and highlights changed
  // results/verdicts — the "what changed since it last worked" workflow.
  diff(sessionAId, sessionBId) {
    const a = this.listArtifacts(sessionAId);
    const b = this.listArtifacts(sessionBId);
    const key = (x) => `${x.driver_id}:${x.verb}:${x.seq}`;
    const bMap = new Map(b.map((x) => [key(x), x]));
    const rows = [];
    for (const ax of a) {
      const bx = bMap.get(key(ax));
      const before = summarize(ax);
      const after = bx ? summarize(bx) : null;
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      rows.push({ key: key(ax), verb: ax.verb, driver_id: ax.driver_id, before, after, changed });
      if (bx) bMap.delete(key(ax));
    }
    for (const bx of bMap.values()) {
      rows.push({
        key: key(bx),
        verb: bx.verb,
        driver_id: bx.driver_id,
        before: null,
        after: summarize(bx),
        changed: true,
      });
    }
    return rows;
  }

  close() {
    this.db.close();
  }
}

function summarize(a) {
  return {
    result: a.result,
    error: a.error,
    verdicts: (a.verdicts || []).map((v) => ({ severity: v.severity, title: v.title })),
  };
}

function safeParse(s, fallback) {
  if (s == null) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function stringifyMaybe(v) {
  if (v == null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function now() {
  // Monotonic-ish wall clock in ms. The architecture anchors this to PTP/NTP;
  // the MVP uses the system clock and records the anchor on the session.
  return Date.now();
}

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}
