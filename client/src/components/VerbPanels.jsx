import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.js';
import { api } from '../api.js';
import { Verdict, HexView, Json, Field, Btn } from './ui.jsx';

// Renders manifest-declared params (§4) as a small form. Every workspace uses
// this one runner, so a new driver's verbs get a UI for free.
function ParamForm({ spec, value, onChange }) {
  if (!spec || Object.keys(spec).length === 0) return null;
  return (
    <div className="flex flex-wrap gap-3 mb-3">
      {Object.entries(spec).map(([name, def]) => (
        <Field key={name} label={name}>
          {def.type === 'enum' ? (
            <select
              value={value[name] ?? def.default}
              onChange={(e) => onChange({ ...value, [name]: e.target.value })}
              className="bg-ink border border-edge rounded px-2 py-1 text-sm"
            >
              {def.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={def.type === 'number' ? 'number' : 'text'}
              value={value[name] ?? def.default ?? ''}
              min={def.min}
              max={def.max}
              onChange={(e) =>
                onChange({ ...value, [name]: def.type === 'number' ? Number(e.target.value) : e.target.value })
              }
              className="bg-ink border border-edge rounded px-2 py-1 text-sm w-28"
            />
          )}
        </Field>
      ))}
    </div>
  );
}

// Generic verb panel: connect / identify / browse / read.
export function GenericVerb({ driver, verb }) {
  const { session, runVerb, flash } = useStore();
  const [params, setParams] = useState({});
  const [artifact, setArtifact] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const a = await runVerb(verb, params);
      setArtifact(a);
    } catch (e) {
      flash(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <ParamForm spec={driver.params?.[verb]} value={params} onChange={setParams} />
      <Btn variant="primary" onClick={run} disabled={!session || busy}>
        {busy ? 'Running…' : `Run ${verb}`}
      </Btn>
      {artifact && (
        <div className="mt-4">
          {artifact.verdicts?.length > 0 && (
            <div className="mb-3">{artifact.verdicts.map((v, i) => <Verdict key={i} v={v} />)}</div>
          )}
          {artifact.result && <ResultView verb={verb} result={artifact.result} />}
          {artifact.error && <div className="text-rose-400 text-sm">error: {artifact.error}</div>}
        </div>
      )}
    </div>
  );
}

function ResultView({ verb, result }) {
  // Browse renders a point tree; everything else a compact key/value + JSON.
  if (verb === 'browse' && result.tree) {
    return (
      <div className="space-y-3">
        {result.tree.map((area, i) => (
          <div key={i} className="border border-edge rounded">
            <div className="px-3 py-1.5 bg-panel2 text-xs uppercase tracking-wider text-slate-400 border-b border-edge">
              {area.area} {area.error && <span className="text-rose-400 normal-case">— {area.error}</span>}
            </div>
            {area.points && (
              <table className="w-full text-sm">
                <tbody>
                  {area.points.map((p) => (
                    <tr key={p.ref} className="border-b border-edge/50">
                      <td className="px-3 py-1 font-mono text-slate-400 w-24">{p.ref}</td>
                      <td className="px-3 py-1 font-mono text-emerald-300">{String(p.value)}</td>
                      <td className="px-3 py-1 text-slate-500 text-xs">{p.type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    );
  }
  return <Json data={result} />;
}

// Diagnose panel (§7, the differentiator): renders verdicts, not raw data.
export function DiagnosePanel() {
  const { runVerb, flash, session } = useStore();
  const [verdicts, setVerdicts] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const a = await runVerb('diagnose', {});
      setVerdicts(a.verdicts || []);
    } catch (e) {
      flash(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="text-xs text-slate-500 mb-3">
        Diagnose correlates the driver's results and transport facts through its YAML rulepack into a
        plain-English verdict — what is wrong and why, with next steps.
      </p>
      <Btn variant="primary" onClick={run} disabled={!session || busy}>
        {busy ? 'Diagnosing…' : 'Run diagnosis'}
      </Btn>
      {verdicts && (
        <div className="mt-4">
          {verdicts.length === 0 ? (
            <div className="text-slate-500 text-sm">No rule matched — no verdict to render.</div>
          ) : (
            verdicts.map((v, i) => <Verdict key={i} v={v} />)
          )}
        </div>
      )}
    </div>
  );
}

// Monitor panel (§7): jitter / min/avg/max RTT / loss + a rolling sparkline.
export function MonitorPanel({ driver }) {
  const { session, monitor, flash } = useStore();
  const [params, setParams] = useState({});
  const [monitorId, setMonitorId] = useState(null);

  async function start() {
    try {
      const r = await api.startMonitor(session.id, params);
      setMonitorId(r.monitorId);
    } catch (e) {
      flash(e.message);
    }
  }
  async function stop() {
    if (monitorId) await api.stopMonitor(monitorId);
    setMonitorId(null);
  }
  useEffect(() => () => { if (monitorId) api.stopMonitor(monitorId).catch(() => {}); }, [monitorId]);

  const stats = monitor?.stats;
  return (
    <div>
      <ParamForm spec={driver.params?.monitor} value={params} onChange={setParams} />
      <div className="flex gap-2">
        {monitorId ? (
          <Btn variant="hazard" onClick={stop}>Stop</Btn>
        ) : (
          <Btn variant="primary" onClick={start} disabled={!session}>Start monitor</Btn>
        )}
      </div>
      {monitor && (
        <div className="mt-4">
          <Sparkline series={monitor.series || []} />
          {stats && (
            <div className="grid grid-cols-5 gap-2 mt-3 text-center">
              <Stat label="samples" value={stats.count} />
              <Stat label="loss %" value={stats.loss_pct} warn={stats.loss_pct > 0} />
              <Stat label="min" value={fmt(stats.min)} />
              <Stat label="avg" value={fmt(stats.avg)} />
              <Stat label="max" value={fmt(stats.max)} />
            </div>
          )}
          <div className="text-center text-xs text-slate-500 mt-1">jitter {fmt(stats?.jitter)}</div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, warn }) {
  return (
    <div className={`rounded border border-edge bg-panel2 py-2 ${warn ? 'text-amber-400' : 'text-slate-200'}`}>
      <div className="text-sm font-mono">{value ?? '—'}</div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
    </div>
  );
}

function fmt(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return typeof n === 'number' ? n.toFixed(1) : n;
}

// Lightweight inline-SVG sparkline (no chart lib needed for a rolling series).
function Sparkline({ series }) {
  const vals = series.filter((v) => typeof v === 'number');
  const W = 600;
  const H = 80;
  if (vals.length < 2) return <div className="h-20 border border-edge rounded bg-ink flex items-center justify-center text-slate-600 text-xs">collecting…</div>;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const pts = series.map((v, i) => {
    const x = (i / (series.length - 1)) * W;
    const y = typeof v === 'number' ? H - ((v - min) / span) * (H - 8) - 4 : H;
    return { x, y, gap: typeof v !== 'number' };
  });
  const d = pts.map((p, i) => `${i === 0 || pts[i - 1].gap ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20 border border-edge rounded bg-ink">
      <path d={d} fill="none" stroke="#34d399" strokeWidth="1.5" />
      {pts.map((p, i) => p.gap ? <circle key={i} cx={p.x} cy={H - 4} r="2" fill="#f43f5e" /> : null)}
    </svg>
  );
}

// Write panel (§4.1): the double-gate flow. Prepare (dry-run, current→proposed),
// then confirm — which the backend only accepts if the session is ARMED.
export function WritePanel({ driver }) {
  const { session, armed, flash } = useStore();
  const [params, setParams] = useState({});
  const [prep, setPrep] = useState(null);
  const [result, setResult] = useState(null);

  async function prepare() {
    setResult(null);
    try {
      setPrep(await api.prepareWrite(session.id, params));
    } catch (e) {
      flash(e.message);
    }
  }
  async function confirm() {
    try {
      const a = await api.confirmWrite(session.id, prep.token);
      setResult(a);
      setPrep(null);
      flash('Write committed and read-back verified');
    } catch (e) {
      flash(e.message);
    }
  }

  return (
    <div>
      <div className="rounded border border-amber-800 bg-amber-950/30 p-3 mb-4 text-xs text-amber-200">
        Writes clear two gates: <b>ARM</b> the session (top bar, Gate 1), then <b>confirm</b> each write
        showing current → proposed (Gate 2). Every write is audited — non-disableable.
      </div>
      <ParamForm spec={driver.params?.write} value={params} onChange={setParams} />
      <div className="flex gap-2">
        <Btn onClick={prepare} disabled={!session}>Dry-run / preview</Btn>
      </div>

      {prep && (
        <div className="mt-4 rounded border border-edge bg-panel2 p-4">
          <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">Confirm write (Gate 2)</div>
          <table className="text-sm mb-3">
            <tbody>
              <Row k="Target" v={prep.target} />
              <Row k="Point" v={prep.point} />
              <Row k="Current value" v={String(prep.current_value ?? '—')} />
              <Row k="Proposed value" v={<span className="text-hazard font-semibold">{String(prep.proposed_value)}</span>} />
            </tbody>
          </table>
          {!armed && (
            <div className="text-rose-400 text-xs mb-2">Session is READ-ONLY — ARM it in the top bar to enable this write.</div>
          )}
          <div className="flex gap-2">
            <Btn variant="hazard" onClick={confirm} disabled={!armed}>Commit write</Btn>
            <Btn onClick={() => setPrep(null)}>Cancel</Btn>
          </div>
        </div>
      )}

      {result && (
        <div className="mt-4">
          <div className={`text-sm mb-2 ${result.result?.verified ? 'text-emerald-400' : 'text-amber-400'}`}>
            {result.result?.ack ? 'ACK received' : 'no ACK'} · read-back{' '}
            {result.result?.read_back ?? '—'} · {result.result?.verified ? 'verified ✓' : 'not verified'}
          </div>
          <Json data={result.result} />
        </div>
      )}
    </div>
  );
}

function Row({ k, v }) {
  return (
    <tr>
      <td className="pr-4 py-0.5 text-slate-500">{k}</td>
      <td className="py-0.5 font-mono text-slate-200">{v}</td>
    </tr>
  );
}

// Raw tab: hex bytes of the most recent artifact from the evidence stream.
export function RawPanel() {
  const artifacts = useStore((s) => s.artifacts);
  const latest = artifacts[0];
  return (
    <div>
      <p className="text-xs text-slate-500 mb-3">
        The actual bytes on the wire for the most recent action — so you can verify the tool isn't
        lying. Pulled from the evidence store.
      </p>
      {latest ? (
        <div>
          <div className="text-xs text-slate-400 mb-2">
            <span className="font-mono">{latest.verb}</span> · artifact {latest.id}
          </div>
          <HexView raw={latest.raw} />
        </div>
      ) : (
        <div className="text-slate-500 text-sm">Run a verb to capture bytes.</div>
      )}
    </div>
  );
}
