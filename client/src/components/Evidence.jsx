import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Verdict, Json, Btn } from './ui.jsx';

// Evidence & reporting view (§7, §9): session timeline, replay, session diff
// ("this worked yesterday"), and the non-disableable audit log.
export default function Evidence() {
  const [sessions, setSessions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [artifacts, setArtifacts] = useState([]);
  const [audit, setAudit] = useState([]);
  const [diffPick, setDiffPick] = useState([]);
  const [diffRows, setDiffRows] = useState(null);

  async function refresh() {
    const [{ sessions }, { entries }] = await Promise.all([api.sessions(), api.audit()]);
    setSessions(sessions);
    setAudit(entries);
  }
  useEffect(() => { refresh(); }, []);

  async function open(s) {
    setSelected(s);
    setDiffRows(null);
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
  }

  return (
    <div className="flex-1 flex min-w-0">
      {/* sessions list */}
      <div className="w-72 border-r border-edge overflow-y-auto shrink-0">
        <div className="px-3 py-2 flex items-center gap-2 border-b border-edge">
          <span className="text-xs uppercase tracking-wider text-slate-500">Sessions</span>
          <Btn onClick={refresh} className="ml-auto !px-2 !py-0.5 !text-xs">↻</Btn>
        </div>
        {sessions.map((s) => (
          <div key={s.id} className={`px-3 py-2 border-b border-edge/50 text-sm cursor-pointer hover:bg-panel ${selected?.id === s.id ? 'bg-panel' : ''}`}>
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={diffPick.includes(s.id)} onChange={() => toggleDiff(s.id)} onClick={(e) => e.stopPropagation()} />
              <span onClick={() => open(s)} className="flex-1">
                <span className="text-slate-200">{s.driver_id}</span>
                <span className="text-slate-500 font-mono text-xs ml-2">{s.address}</span>
              </span>
            </div>
            <div className="text-[10px] text-slate-600 ml-6">{new Date(s.started_at).toLocaleString()}</div>
          </div>
        ))}
        {diffPick.length === 2 && (
          <div className="p-2"><Btn variant="primary" onClick={runDiff} className="w-full">Diff selected 2</Btn></div>
        )}
      </div>

      {/* detail */}
      <div className="flex-1 overflow-y-auto p-5 min-w-0">
        {diffRows ? (
          <DiffView rows={diffRows} />
        ) : selected ? (
          <Timeline artifacts={artifacts} />
        ) : (
          <AuditView audit={audit} />
        )}
      </div>
    </div>
  );
}

function Timeline({ artifacts }) {
  return (
    <div>
      <h2 className="text-sm uppercase tracking-wider text-slate-500 mb-3">Session replay — {artifacts.length} artifacts</h2>
      {artifacts.map((a) => (
        <div key={a.id} className="border border-edge rounded mb-2">
          <div className="px-3 py-1.5 bg-panel2 border-b border-edge flex items-center gap-2 text-xs">
            <span className="font-mono text-slate-500">#{a.seq}</span>
            <span className="text-slate-200 capitalize">{a.verb}</span>
            <span className="text-slate-600 ml-auto">{new Date(a.timestamp_ptp).toLocaleTimeString()}</span>
          </div>
          <div className="p-3">
            {a.verdicts?.map((v, i) => <Verdict key={i} v={v} />)}
            {a.result && <Json data={a.result} />}
            {a.error && <div className="text-rose-400 text-sm">{a.error}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function DiffView({ rows }) {
  return (
    <div>
      <h2 className="text-sm uppercase tracking-wider text-slate-500 mb-3">Session diff — what changed</h2>
      <table className="w-full text-xs border border-edge">
        <thead>
          <tr className="bg-panel2 text-slate-500">
            <th className="px-3 py-1.5 text-left">verb</th>
            <th className="px-3 py-1.5 text-left">before (A)</th>
            <th className="px-3 py-1.5 text-left">after (B)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={`border-t border-edge/50 ${r.changed ? 'bg-amber-950/20' : ''}`}>
              <td className="px-3 py-1.5 capitalize">{r.verb} {r.changed && <span className="text-amber-400">●</span>}</td>
              <td className="px-3 py-1.5 font-mono text-slate-400">{cell(r.before)}</td>
              <td className="px-3 py-1.5 font-mono text-slate-400">{cell(r.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
    <div>
      <h2 className="text-sm uppercase tracking-wider text-slate-500 mb-1">Audit log</h2>
      <p className="text-xs text-slate-500 mb-3">Non-disableable. Every ARM, disarm, and write is recorded with before/after and the confirmation.</p>
      <table className="w-full text-xs border border-edge">
        <thead>
          <tr className="bg-panel2 text-slate-500">
            <th className="px-3 py-1.5 text-left">time</th>
            <th className="px-3 py-1.5 text-left">action</th>
            <th className="px-3 py-1.5 text-left">target</th>
            <th className="px-3 py-1.5 text-left">point</th>
            <th className="px-3 py-1.5 text-left">before → after</th>
          </tr>
        </thead>
        <tbody>
          {audit.length === 0 ? (
            <tr><td colSpan={5} className="px-3 py-3 text-slate-600">No audited actions yet.</td></tr>
          ) : audit.map((a) => (
            <tr key={a.id} className="border-t border-edge/50">
              <td className="px-3 py-1.5 text-slate-500">{new Date(a.timestamp).toLocaleTimeString()}</td>
              <td className="px-3 py-1.5 text-slate-200">{a.action}</td>
              <td className="px-3 py-1.5 font-mono text-slate-400">{a.target}</td>
              <td className="px-3 py-1.5 font-mono text-slate-400">{a.point}</td>
              <td className="px-3 py-1.5 font-mono text-hazard">{a.before_value ?? '—'} → {a.after_value ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
