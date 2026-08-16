import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Verdict, Json, Btn, Icon, Badge, EmptyState, SeverityChip } from './ui.jsx';

// Evidence & reporting view (§7, §9): session timeline, replay, session diff
// ("this worked yesterday"), and the non-disableable audit log.
export default function Evidence() {
  const [sessions, setSessions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [artifacts, setArtifacts] = useState([]);
  const [audit, setAudit] = useState([]);
  const [diffPick, setDiffPick] = useState([]);
  const [diffRows, setDiffRows] = useState(null);
  const [backups, setBackups] = useState([]);
  const [backupPick, setBackupPick] = useState([]);
  const [drift, setDrift] = useState(null);
  const [view, setView] = useState('audit'); // audit | timeline | diff | backups | drift

  const [watches, setWatches] = useState([]);

  async function refresh() {
    const [{ sessions }, { entries }, { backups }, { watches }] = await Promise.all([api.sessions(), api.audit(), api.backups(), api.backupWatches()]);
    setSessions(sessions);
    setAudit(entries);
    setBackups(backups);
    setWatches(watches.map((w) => w.baselineId));
  }
  useEffect(() => { refresh(); }, []);

  async function open(s) {
    setSelected(s);
    setDiffRows(null);
    setView('timeline');
    const { artifacts } = await api.replay(s.id);
    setArtifacts(artifacts);
  }
  function toggleDiff(id) {
    setDiffPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)));
  }
  async function runDiff() {
    if (diffPick.length !== 2) return;
    const { rows } = await api.diff(diffPick[0], diffPick[1]);
    setDiffRows(rows);
    setSelected(null);
    setView('diff');
  }
  async function captureBaseline(session) {
    const name = window.prompt('Name this config baseline', `${session.driver_id} ${new Date().toLocaleDateString()}`);
    if (name == null) return;
    await api.captureBackup(session.id, name || undefined);
    await refresh();
    setView('backups');
  }
  function toggleBackupPick(id) {
    setBackupPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)));
  }
  async function runDrift() {
    if (backupPick.length !== 2) return;
    const res = await api.backupDiff(backupPick[0], backupPick[1]);
    setDrift(res);
    setSelected(null);
    setView('drift');
  }
  async function recheck(id) {
    const res = await api.recheckBaseline(id);
    setDrift(res);
    setSelected(null);
    setView('drift');
  }
  async function toggleWatch(id) {
    if (watches.includes(id)) await api.unwatchBaseline(id);
    else await api.watchBaseline(id, 300);
    await refresh();
  }
  async function importBaseline(file) {
    if (!file) return;
    try {
      const doc = JSON.parse(await file.text());
      await api.importBackup(doc);
      await refresh();
      setView('backups');
    } catch (err) {
      window.alert(`Import failed: ${err.message}`);
    }
  }

  return (
    <div className="flex-1 flex min-w-0">
      {/* sessions list */}
      <div className="w-80 border-r border-edge overflow-y-auto shrink-0 bg-panel2/40">
        <div className="px-3 py-2.5 flex items-center gap-2 border-b border-edge sticky top-0 bg-panel2 z-10">
          <Icon name="file" size={14} className="text-slate-500" />
          <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Sessions</span>
          <span className="text-xs text-slate-600">{sessions.length}</span>
          <button onClick={() => { refresh(); setView('audit'); setSelected(null); }} className="ml-auto text-slate-500 hover:text-slate-200" title="Refresh">
            <Icon name="refresh" size={14} />
          </button>
        </div>
        {sessions.length === 0 && <div className="px-4 py-6 text-center text-xs text-slate-600">No sessions yet.</div>}
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`px-3 py-2.5 border-b border-edge/50 text-sm cursor-pointer hover:bg-white/[0.03] ${selected?.id === s.id ? 'bg-white/5' : ''}`}
          >
            <div className="flex items-center gap-2.5">
              <input
                type="checkbox"
                checked={diffPick.includes(s.id)}
                onChange={() => toggleDiff(s.id)}
                onClick={(e) => e.stopPropagation()}
                className="accent-emerald-500"
              />
              <span onClick={() => open(s)} className="flex-1 min-w-0">
                <span className="text-slate-200">{s.driver_id}</span>
                <span className="text-slate-500 font-mono text-xs ml-2">{s.address}</span>
              </span>
            </div>
            <div className="text-[10px] text-slate-600 ml-6 mt-0.5">{new Date(s.started_at).toLocaleString()}</div>
          </div>
        ))}
        {diffPick.length === 2 && (
          <div className="p-2 sticky bottom-0 bg-panel2 border-t border-edge">
            <Btn variant="primary" size="sm" onClick={runDiff} icon="layers" className="w-full">Diff selected sessions</Btn>
          </div>
        )}
      </div>

      {/* detail */}
      <div className="flex-1 overflow-y-auto p-6 min-w-0">
        <div className="flex items-center gap-2 mb-4">
          <Btn size="sm" variant={view === 'audit' ? 'primary' : 'ghost'} icon="shield" onClick={() => { setView('audit'); setSelected(null); }}>Audit</Btn>
          <Btn size="sm" variant={view === 'backups' || view === 'drift' ? 'primary' : 'ghost'} icon="layers" onClick={() => { setView('backups'); setSelected(null); }}>Config baselines <span className="opacity-60 ml-1">{backups.length}</span></Btn>
        </div>
        {view === 'diff' && diffRows ? (
          <DiffView rows={diffRows} />
        ) : view === 'timeline' && selected ? (
          <Timeline session={selected} artifacts={artifacts} onCapture={() => captureBaseline(selected)} />
        ) : view === 'drift' && drift ? (
          <DriftView drift={drift} />
        ) : view === 'backups' ? (
          <BackupsView backups={backups} pick={backupPick} watches={watches} onToggle={toggleBackupPick} onDrift={runDrift} onRecheck={recheck} onToggleWatch={toggleWatch} onImport={importBaseline} />
        ) : (
          <AuditView audit={audit} />
        )}
      </div>
    </div>
  );
}

function Timeline({ session, artifacts, onCapture }) {
  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-sm uppercase tracking-wider text-slate-400 font-semibold">Session replay</h2>
        <Badge>{artifacts.length} artifacts</Badge>
        <Btn size="sm" variant="ghost" icon="layers" className="ml-auto" onClick={onCapture} title="Snapshot this device's readable config as a named baseline to diff against later">
          Save config baseline
        </Btn>
        <a
          href={`/api/sessions/${session.id}/inventory.csv`}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-edge2 bg-raised/60 text-slate-200 hover:bg-raised"
        >
          <Icon name="download" size={14} /> Inventory CSV
        </a>
        <a
          href={`/api/sessions/${session.id}/report`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-edge2 bg-raised/60 text-slate-200 hover:bg-raised"
        >
          <Icon name="download" size={14} /> Export commissioning report
        </a>
      </div>
      {artifacts.length === 0 ? (
        <EmptyState title="No artifacts in this session" icon="file" />
      ) : (
        <div className="space-y-2">
          {artifacts.map((a) => (
            <div key={a.id} className="rounded-lg border border-edge overflow-hidden">
              <div className="px-3 py-1.5 bg-white/[0.02] border-b border-edge flex items-center gap-2 text-xs">
                <span className="font-mono text-slate-600">#{a.seq}</span>
                <span className="text-slate-200 capitalize font-medium">{a.verb}</span>
                {a.verdicts?.[0] && <SeverityChip severity={a.verdicts[0].severity} />}
                {a.has_raw && <Badge tone="emerald">raw</Badge>}
                <span className="text-slate-600 ml-auto flex items-center gap-1"><Icon name="clock" size={11} />{new Date(a.timestamp_ptp).toLocaleTimeString()}</span>
              </div>
              <div className="p-3">
                {a.verdicts?.map((v, i) => <Verdict key={i} v={v} />)}
                {a.result && <Json data={a.result} />}
                {a.error && <div className="text-rose-400 text-sm">{a.error}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DiffView({ rows }) {
  const changed = rows.filter((r) => r.changed).length;
  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-sm uppercase tracking-wider text-slate-400 font-semibold">Session diff</h2>
        <Badge tone={changed ? 'amber' : 'emerald'}>{changed} changed</Badge>
        <span className="text-xs text-slate-500">what changed since it last worked</span>
      </div>
      <div className="rounded-lg border border-edge overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-white/[0.03] text-slate-500">
              <th className="px-3 py-2 text-left font-medium">verb</th>
              <th className="px-3 py-2 text-left font-medium">before (A)</th>
              <th className="px-3 py-2 text-left font-medium">after (B)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={`border-t border-edge/50 ${r.changed ? 'bg-amber-500/[0.06]' : ''}`}>
                <td className="px-3 py-2 capitalize whitespace-nowrap">
                  {r.changed && <span className="text-amber-400 mr-1">●</span>}
                  {r.verb}
                </td>
                <td className="px-3 py-2 font-mono text-slate-400">{cell(r.before)}</td>
                <td className="px-3 py-2 font-mono text-slate-400">{cell(r.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Config baselines: named snapshots of a device's readable config, picked two at
// a time to compute drift.
function BackupsView({ backups, pick, watches, onToggle, onDrift, onRecheck, onToggleWatch, onImport }) {
  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-2 mb-1">
        <Icon name="layers" size={16} className="text-slate-500" />
        <h2 className="text-sm uppercase tracking-wider text-slate-400 font-semibold">Config baselines</h2>
        <Badge>{backups.length}</Badge>
        <label className="ml-auto inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-edge2 bg-raised/60 text-slate-300 hover:bg-raised cursor-pointer">
          <Icon name="download" size={13} /> Import baseline
          <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { onImport(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {pick.length === 2 && <Btn size="sm" variant="primary" icon="layers" onClick={onDrift}>Compare drift</Btn>}
      </div>
      <p className="text-xs text-slate-500 mb-4">
        A baseline is a normalized snapshot of a device's readable configuration (identity + point values). Capture one
        from a session's replay ("Save config baseline"), check two to diff them, or <span className="text-slate-300">Recheck</span> to
        re-read the device now and see live drift. <span className="text-slate-300">Watch</span> re-checks on an interval.
      </p>
      {backups.length === 0 ? (
        <EmptyState title="No baselines yet" icon="layers">Open a session and use “Save config baseline”, or import one.</EmptyState>
      ) : (
        <div className="rounded-lg border border-edge overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-white/[0.03] text-slate-500">
                {['', 'name', 'driver', 'address', 'points', 'captured', ''].map((h, i) => (
                  <th key={i} className="px-3 py-2 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id} className={`border-t border-edge/50 hover:bg-white/[0.02] ${pick.includes(b.id) ? 'bg-white/5' : ''}`}>
                  <td className="px-3 py-2"><input type="checkbox" checked={pick.includes(b.id)} onChange={() => onToggle(b.id)} className="accent-emerald-500" /></td>
                  <td className="px-3 py-2 text-slate-200">{b.name} {watches.includes(b.id) && <Badge tone="emerald" className="ml-1">watching</Badge>}</td>
                  <td className="px-3 py-2 text-slate-400">{b.driver_id}</td>
                  <td className="px-3 py-2 font-mono text-slate-500">{b.address}</td>
                  <td className="px-3 py-2 text-slate-400">{b.point_count}</td>
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{new Date(b.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    <div className="inline-flex items-center gap-1">
                      <Btn size="sm" variant="ghost" onClick={() => onRecheck(b.id)}>Recheck</Btn>
                      <Btn size="sm" variant={watches.includes(b.id) ? 'subtle' : 'ghost'} onClick={() => onToggleWatch(b.id)}>{watches.includes(b.id) ? 'Unwatch' : 'Watch'}</Btn>
                      <a href={`/api/backups/${b.id}/export`} className="text-slate-500 hover:text-slate-200 px-1.5 py-1" title="Export baseline as JSON"><Icon name="download" size={13} /></a>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pick.length === 2 && (
        <p className="text-[11px] text-slate-600 mt-2">Baseline A = first checked, compared against B = second checked.</p>
      )}
    </div>
  );
}

// Drift between two config baselines — added / removed / changed points.
function DriftView({ drift }) {
  const { summary, severity, title, rows, baseline, current } = drift;
  const shown = rows.filter((r) => r.status !== 'unchanged');
  const tone = { changed: 'amber', added: 'emerald', removed: 'hazard' };
  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-3 mb-1">
        <h2 className="text-sm uppercase tracking-wider text-slate-400 font-semibold">Config drift</h2>
        <SeverityChip severity={severity} />
        <Badge tone={summary.drifted ? 'amber' : 'emerald'}>{summary.drifted} drifted / {summary.total}</Badge>
      </div>
      <p className="text-sm text-slate-300 mb-1">{title}</p>
      <p className="text-xs text-slate-500 mb-4">baseline <span className="text-slate-300">{baseline?.name}</span> → <span className="text-slate-300">{current?.name}</span></p>
      {shown.length === 0 ? (
        <EmptyState title="No drift — every point matches the baseline" icon="ok" />
      ) : (
        <div className="rounded-lg border border-edge overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-white/[0.03] text-slate-500">
                {['', 'point', 'baseline', 'current'].map((h, i) => (
                  <th key={i} className="px-3 py-2 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key} className="border-t border-edge/50">
                  <td className="px-3 py-2"><Badge tone={tone[r.status] || 'slate'}>{r.status}</Badge></td>
                  <td className="px-3 py-2 font-mono text-slate-300">{r.group}/{r.point}</td>
                  <td className="px-3 py-2 font-mono text-slate-400">{r.before ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-amber-300">{r.after ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function cell(x) {
  if (!x) return '—';
  if (x.error) return `error: ${x.error}`;
  if (x.verdicts?.length) return x.verdicts.map((v) => v.title).join('; ');
  return JSON.stringify(x.result)?.slice(0, 80) || '—';
}

function AuditView({ audit }) {
  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-2 mb-1">
        <Icon name="shield" size={16} className="text-slate-500" />
        <h2 className="text-sm uppercase tracking-wider text-slate-400 font-semibold">Audit log</h2>
        <Badge>{audit.length}</Badge>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        Non-disableable. Every ARM, disarm, and write is recorded with before/after and the confirmation. Select a
        session at left to replay its timeline, or check two to diff them.
      </p>
      <div className="rounded-lg border border-edge overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-white/[0.03] text-slate-500">
              {['time', 'action', 'target', 'point', 'before → after'].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {audit.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-600">No audited actions yet.</td></tr>
            ) : (
              audit.map((a) => (
                <tr key={a.id} className="border-t border-edge/50 hover:bg-white/[0.02]">
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{new Date(a.timestamp).toLocaleTimeString()}</td>
                  <td className="px-3 py-2">
                    <Badge tone={a.action === 'arm' ? 'hazard' : a.action.includes('write') || a.action.includes('publish') ? 'amber' : 'slate'}>{a.action}</Badge>
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-400">{a.target}</td>
                  <td className="px-3 py-2 font-mono text-slate-400">{a.point}</td>
                  <td className="px-3 py-2 font-mono text-hazard">{a.before_value ?? '—'} → {a.after_value ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
