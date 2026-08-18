import React, { useEffect, useState } from 'react';
import { useStore } from '../store.js';
import { api } from '../api.js';
import { Verdict, HexView, Json, Field, Btn, Input, Select, Icon, Badge, EmptyState, KV, SeverityChip } from './ui.jsx';

// Seed the manifest-declared defaults so unedited fields are still submitted —
// otherwise an immediate run/preview sends `undefined` for values the form only
// *displays* as a placeholder default.
function defaultsFor(spec) {
  const out = {};
  if (spec) for (const [k, def] of Object.entries(spec)) if (def.default !== undefined) out[k] = def.default;
  return out;
}

// Renders manifest-declared params (§4) as a small form. Every workspace uses
// this one runner, so a new driver's verbs get a UI for free.
function ParamForm({ spec, value, onChange }) {
  if (!spec || Object.keys(spec).length === 0) return null;
  return (
    <div className="flex flex-wrap gap-3 mb-4">
      {Object.entries(spec).map(([name, def]) => (
        <Field key={name} label={name.replace(/_/g, ' ')}>
          {def.type === 'enum' ? (
            <Select value={value[name] ?? def.default} onChange={(e) => onChange({ ...value, [name]: e.target.value })}>
              {def.options.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </Select>
          ) : (
            <Input
              type={def.type === 'number' ? 'number' : 'text'}
              value={value[name] ?? def.default ?? ''}
              min={def.min}
              max={def.max}
              onChange={(e) => onChange({ ...value, [name]: def.type === 'number' ? Number(e.target.value) : e.target.value })}
              className="w-32"
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
  const spec = driver.params?.[verb];
  const [params, setParams] = useState(() => defaultsFor(spec));
  const [artifact, setArtifact] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setParams(defaultsFor(spec)); setArtifact(null); }, [driver.id, verb]);

  async function run() {
    setBusy(true);
    try {
      setArtifact(await runVerb(verb, params));
    } catch (e) {
      flash(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl animate-fade-in">
      <ParamForm spec={spec} value={params} onChange={setParams} />
      <Btn variant="primary" onClick={run} disabled={!session} busy={busy} icon="play">
        {busy ? 'Running…' : `Run ${verb}`}
      </Btn>
      {artifact && (
        <div className="mt-5">
          {artifact.verdicts?.length > 0 && <div className="mb-3">{artifact.verdicts.map((v, i) => <Verdict key={i} v={v} />)}</div>}
          {artifact.result && <ResultView verb={verb} result={artifact.result} />}
          {artifact.error && (
            <div className="flex items-center gap-2 text-sm text-rose-400 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2">
              <Icon name="error" size={16} /> {artifact.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResultView({ verb, result }) {
  // A topology result (PROFINET DCP browse) renders as a device graph.
  if (result.topology) return <TopologyView topo={result.topology} extra={result} />;
  // Any result carrying a `tree` (browse, or scan/discovery verbs) renders as a
  // grouped table; everything else a JSON card.
  if (result.tree) {
    return (
      <div className="space-y-3">
        {result.tree.map((area, i) => (
          <div key={i} className="surface rounded-xl overflow-hidden">
            <div className="px-3 py-2 bg-gradient-to-b from-white/[0.05] to-transparent text-[11px] uppercase tracking-wider text-slate-400 border-b border-edge flex items-center gap-2">
              <Icon name="layers" size={13} className="text-slate-500" />
              {area.area}
              {area.error && <span className="text-rose-400 normal-case ml-auto">{area.error}</span>}
              {area.points && <span className="ml-auto text-slate-600">{area.points.length} points</span>}
            </div>
            {area.points && area.points.length > 0 && (
              <table className="w-full text-sm">
                <tbody>
                  {area.points.map((p) => (
                    <tr key={p.ref} className="border-b border-edge/40 last:border-0 hover:bg-white/[0.02]">
                      <td className="px-3 py-1.5 font-mono text-slate-400 w-40 truncate">{p.ref}</td>
                      <td className="px-3 py-1.5 font-mono text-emerald-300 break-all">{String(p.value)}</td>
                      <td className="px-3 py-1.5 text-slate-500 text-xs text-right whitespace-nowrap">{p.type}</td>
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

const TOPO_KIND = {
  segment: { fill: '#0f1720', stroke: '#334155', text: '#94a3b8', tag: 'subnet' },
  controller: { fill: 'rgba(16,185,129,0.10)', stroke: '#10b981', text: '#6ee7b7', tag: 'IO-Controller' },
  supervisor: { fill: 'rgba(139,92,246,0.10)', stroke: '#8b5cf6', text: '#c4b5fd', tag: 'PN-Supervisor' },
  device: { fill: 'rgba(56,189,248,0.08)', stroke: '#38bdf8', text: '#7dd3fc', tag: 'IO-Device' },
  switch: { fill: 'rgba(148,163,184,0.08)', stroke: '#64748b', text: '#cbd5e1', tag: 'switch' },
};

function TopoWarnings({ extra, note }) {
  return (
    <>
      {(extra?.duplicate_names?.length > 0 || extra?.unconfigured?.length > 0) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {extra.duplicate_names?.length > 0 && (
            <span className="rounded-md border border-rose-500/30 bg-rose-500/10 text-rose-300 px-2 py-1 flex items-center gap-1.5">
              <Icon name="warn" size={12} /> duplicate name: {extra.duplicate_names.join(', ')}
            </span>
          )}
          {extra.unconfigured?.length > 0 && (
            <span className="rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-300 px-2 py-1 flex items-center gap-1.5">
              <Icon name="warn" size={12} /> unconfigured (no IP): {extra.unconfigured.join(', ')}
            </span>
          )}
        </div>
      )}
      {note && <p className="text-[11px] text-slate-600 leading-relaxed">{note}</p>}
    </>
  );
}

// PROFINET topology map. Physical (LLDP) draws device boxes with their ports and
// the port-to-port cabling. Logical (DCP-only) is the subnet → controller →
// device fallback when no LLDP neighbours are seen.
function TopologyView({ topo, extra }) {
  if ((topo.nodes || []).length === 0) {
    return <EmptyState title="No devices on the segment" icon="layers">{topo.note || 'Run Identify-All against a segment with devices.'}</EmptyState>;
  }
  return topo.kind === 'physical' ? <PhysicalTopology topo={topo} extra={extra} /> : <LogicalTopology topo={topo} extra={extra} />;
}

// LLDP port-level graph: boxes carry their ports; cables join specific ports.
function PhysicalTopology({ topo, extra }) {
  const nodes = topo.nodes;
  const links = topo.links || [];
  const byName = Object.fromEntries(nodes.map((n) => [n.label, n]));
  // Depth = hops from a controller, over the LLDP link graph (BFS).
  const adj = new Map(nodes.map((n) => [n.label, []]));
  for (const l of links) { adj.get(l.a.station)?.push(l.b.station); adj.get(l.b.station)?.push(l.a.station); }
  const depth = new Map();
  const roots = nodes.filter((n) => n.kind === 'controller').map((n) => n.label);
  const queue = [...(roots.length ? roots : [nodes[0].label])];
  queue.forEach((r) => depth.set(r, 0));
  while (queue.length) {
    const s = queue.shift();
    for (const nb of adj.get(s) || []) if (!depth.has(nb)) { depth.set(nb, depth.get(s) + 1); queue.push(nb); }
  }
  for (const n of nodes) if (!depth.has(n.label)) depth.set(n.label, 0);

  const NW = 224;
  const HEADER = 42;
  const PORTH = 24;
  const PADB = 12;
  const GAP = 26;
  const COLW = NW + 78;
  const nodeH = (n) => HEADER + Math.max(1, n.ports.length) * PORTH + PADB;
  const byDepth = new Map();
  for (const n of nodes) { const d = depth.get(n.label); (byDepth.get(d) || byDepth.set(d, []).get(d)).push(n); }
  const pos = {};
  let maxY = 0;
  for (const [d, ns] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    let y = 22;
    for (const n of ns) { pos[n.label] = { x: 24 + d * COLW, y, node: n }; y += nodeH(n) + GAP; }
    maxY = Math.max(maxY, y);
  }
  const maxDepth = Math.max(...[...byDepth.keys()]);
  const W = 24 + (maxDepth + 1) * COLW;
  const H = Math.max(maxY, 120);
  const portIndex = (n, port) => Math.max(0, n.ports.findIndex((p) => p.name === port));
  const chipY = (p, idx) => p.y + HEADER + idx * PORTH + PORTH / 2;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-slate-400">
        <Icon name="layers" size={13} className="text-slate-500" /> Physical topology · LLDP
        <span className="ml-auto normal-case text-slate-600">{nodes.length} devices · {links.length} cables</span>
      </div>
      <div className="rounded-lg border border-edge bg-ink overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: Math.min(W, 900), height: H }}>
          {/* cables between specific ports */}
          {links.map((l, i) => {
            const pa = pos[l.a.station];
            const pb = pos[l.b.station];
            if (!pa || !pb) return null;
            const da = depth.get(l.a.station);
            const db = depth.get(l.b.station);
            const aRight = da <= db;
            const ax = aRight ? pa.x + NW : pa.x;
            const bx = aRight ? pb.x : pb.x + NW;
            const ay = chipY(pa, portIndex(pa.node, l.a.port));
            const by = chipY(pb, portIndex(pb.node, l.b.port));
            const dx = Math.max(40, Math.abs(bx - ax) / 2);
            const c1 = ax + (aRight ? dx : -dx);
            const c2 = bx + (aRight ? -dx : dx);
            return (
              <g key={i}>
                <path d={`M${ax},${ay} C${c1},${ay} ${c2},${by} ${bx},${by}`} fill="none" stroke="#2f7d5b" strokeWidth="2" />
                <circle cx={ax} cy={ay} r="3" fill="#34d399" />
                <circle cx={bx} cy={by} r="3" fill="#34d399" />
              </g>
            );
          })}
          {/* device boxes with ports */}
          {nodes.map((n) => {
            const p = pos[n.label];
            const k = TOPO_KIND[n.kind] || TOPO_KIND.device;
            const h = nodeH(n);
            return (
              <g key={n.label} transform={`translate(${p.x},${p.y})`}>
                <rect width={NW} height={h} rx="9" fill={k.fill} stroke={k.stroke} strokeWidth="1.5" />
                <text x="12" y="18" fontSize="13" fontWeight="700" fill={k.text} style={{ fontFamily: 'ui-monospace, monospace' }}>{(n.label || '').slice(0, 24)}</text>
                <text x="12" y="33" fontSize="10" fill="#64748b" style={{ fontFamily: 'ui-monospace, monospace' }}>{`${n.ip || 'no IP'} · ${k.tag}`}</text>
                <line x1="0" x2={NW} y1={HEADER - 4} y2={HEADER - 4} stroke={k.stroke} strokeWidth="1" opacity="0.4" />
                {n.ports.map((port, i) => {
                  const y = HEADER + i * PORTH;
                  return (
                    <g key={port.name} transform={`translate(0,${y})`}>
                      <rect x="8" y="2" width={NW - 16} height={PORTH - 5} rx="5" fill={port.linked ? 'rgba(52,211,153,0.08)' : 'transparent'} stroke={port.linked ? '#2f7d5b' : '#334155'} strokeWidth="1" strokeDasharray={port.linked ? '0' : '3 3'} />
                      <circle cx="18" cy={PORTH / 2} r="3" fill={port.linked ? '#34d399' : '#475569'} />
                      <text x="30" y={PORTH / 2 + 3.5} fontSize="11" fill={port.linked ? '#a7f3d0' : '#94a3b8'} style={{ fontFamily: 'ui-monospace, monospace' }}>{port.name}</text>
                      <text x={NW - 16} y={PORTH / 2 + 3.5} fontSize="9" textAnchor="end" fill={port.linked ? '#4b8f6f' : '#475569'} style={{ fontFamily: 'ui-monospace, monospace' }}>{port.linked ? 'linked' : 'free'}</text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <TopoWarnings extra={extra} note={topo.note} />
    </div>
  );
}

// DCP-only fallback: a layered segment → controller → devices graph.
function LogicalTopology({ topo, extra }) {
  const nodes = topo.nodes || [];
  const edges = topo.edges || [];
  const COL = { segment: 0, controller: 1, supervisor: 1, device: 2 };
  const colX = [30, 300, 570];
  const NW = 200;
  const NH = 50;
  const GAP = 22;
  const counts = [0, 0, 0];
  const pos = {};
  for (const n of nodes) {
    const c = COL[n.kind] ?? 2;
    const i = counts[c]++;
    pos[n.id] = { x: colX[c], y: 20 + i * (NH + GAP), c };
  }
  const rows = Math.max(...counts, 1);
  const W = 790;
  const H = 20 + rows * (NH + GAP);
  const center = (p) => ({ x: p.x + NW / 2, y: p.y + NH / 2 });
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-slate-400">
        <Icon name="layers" size={13} className="text-slate-500" /> Logical topology · DCP
        <span className="ml-auto normal-case text-slate-600">{nodes.filter((n) => n.kind !== 'segment').length} devices</span>
      </div>
      <div className="rounded-lg border border-edge bg-ink overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 640, height: H }}>
          {edges.map((e, i) => {
            const a = pos[e.from];
            const b = pos[e.to];
            if (!a || !b) return null;
            const p1 = center(a);
            const p2 = center(b);
            const mx = (p1.x + p2.x) / 2;
            return <path key={i} d={`M${p1.x + NW / 2},${p1.y} C${mx},${p1.y} ${mx},${p2.y} ${p2.x - NW / 2},${p2.y}`} fill="none" stroke="#243244" strokeWidth="1.5" />;
          })}
          {nodes.map((n) => {
            const p = pos[n.id];
            const k = TOPO_KIND[n.kind] || TOPO_KIND.device;
            return (
              <g key={n.id} transform={`translate(${p.x},${p.y})`}>
                <rect width={NW} height={NH} rx="8" fill={k.fill} stroke={k.stroke} strokeWidth="1.5" />
                <text x="12" y="21" fontSize="13" fontWeight="600" fill={k.text} style={{ fontFamily: 'ui-monospace, monospace' }}>{(n.label || '').slice(0, 22)}</text>
                <text x="12" y="38" fontSize="10.5" fill="#64748b" style={{ fontFamily: 'ui-monospace, monospace' }}>{n.kind === 'segment' ? k.tag : `${n.ip || 'no IP'}${n.role ? ' · ' + n.role : ''}`}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <TopoWarnings extra={extra} note={topo.note} />
    </div>
  );
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
    <div className="max-w-4xl animate-fade-in">
      <div className="flex items-start gap-3 mb-4 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] px-4 py-3">
        <Icon name="shield" size={18} className="text-emerald-400 mt-0.5" />
        <p className="text-[13px] text-slate-400 leading-relaxed">
          Diagnose correlates the driver's results and transport facts through its YAML rulepack into a plain-English
          verdict — <span className="text-slate-300">what is wrong and why</span>, with next steps.
        </p>
      </div>
      <Btn variant="primary" onClick={run} disabled={!session} busy={busy} icon="shield">
        {busy ? 'Diagnosing…' : 'Run diagnosis'}
      </Btn>
      {verdicts && (
        <div className="mt-5">
          {verdicts.length === 0 ? (
            <EmptyState title="No rule matched" icon="info">The rulepack produced no verdict for the observed facts.</EmptyState>
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
  const [params, setParams] = useState(() => defaultsFor(driver.params?.monitor));
  const [monitorId, setMonitorId] = useState(null);
  const [summary, setSummary] = useState(null);
  useEffect(() => setParams(defaultsFor(driver.params?.monitor)), [driver.id]);

  async function start() {
    try {
      setSummary(null);
      const r = await api.startMonitor(session.id, params);
      setMonitorId(r.monitorId);
    } catch (e) {
      flash(e.message);
    }
  }
  async function stop() {
    if (monitorId) {
      const r = await api.stopMonitor(monitorId).catch(() => null);
      if (r?.verdicts?.length) setSummary(r);
    }
    setMonitorId(null);
  }
  useEffect(() => () => { if (monitorId) api.stopMonitor(monitorId).catch(() => {}); }, [monitorId]);

  const stats = monitor?.stats;
  return (
    <div className="max-w-4xl animate-fade-in">
      <ParamForm spec={driver.params?.monitor} value={params} onChange={setParams} />
      <div className="flex items-center gap-2">
        {monitorId ? (
          <Btn variant="hazard" onClick={stop} icon="stop">Stop monitor</Btn>
        ) : (
          <Btn variant="primary" onClick={start} disabled={!session} icon="play">Start monitor</Btn>
        )}
        {monitorId && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> streaming
          </span>
        )}
      </div>
      {monitorId && monitor ? (
        <div className="mt-5">
          <Sparkline series={monitor.series || []} />
          {stats && (
            <div className="grid grid-cols-5 gap-2 mt-3">
              <Stat label="samples" value={stats.count} />
              <Stat label="loss %" value={stats.loss_pct} warn={stats.loss_pct > 0} unit="%" />
              <Stat label="min" value={fmt(stats.min)} unit="ms" />
              <Stat label="avg" value={fmt(stats.avg)} unit="ms" />
              <Stat label="max" value={fmt(stats.max)} unit="ms" />
            </div>
          )}
          <div className="text-center text-xs text-slate-500 mt-2">jitter (σ) {fmt(stats?.jitter)} ms</div>
        </div>
      ) : summary ? (
        <div className="mt-5 space-y-3">
          {summary.verdicts.map((v, i) => <Verdict key={i} v={v} />)}
          <div className="grid grid-cols-5 gap-2">
            <Stat label="samples" value={summary.summary.samples} />
            <Stat label="loss %" value={summary.summary.loss_pct} warn={summary.summary.loss_pct > 0} unit="%" />
            <Stat label="min" value={fmt(summary.summary.min_ms)} unit="ms" />
            <Stat label="avg" value={fmt(summary.summary.avg_ms)} unit="ms" />
            <Stat label="jitter" value={fmt(summary.summary.jitter_ms)} unit="ms" />
          </div>
          <div className="text-center text-[11px] text-slate-600">Monitor summary stored to the session evidence.</div>
        </div>
      ) : (
        <div className="mt-5"><EmptyState title="Not monitoring" icon="activity">Start a monitor to stream RTT, loss, and jitter with a rolling sparkline.</EmptyState></div>
      )}
    </div>
  );
}

function Stat({ label, value, warn, unit }) {
  return (
    <div className={`rounded-lg border bg-panel py-2.5 text-center ${warn ? 'border-amber-500/40 bg-amber-500/[0.06]' : 'border-edge'}`}>
      <div className={`text-lg font-mono tabular-nums ${warn ? 'text-amber-400' : 'text-slate-100'}`}>
        {value ?? '—'}{value != null && value !== '—' && unit && <span className="text-[10px] text-slate-500 ml-0.5">{unit}</span>}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
    </div>
  );
}

function fmt(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return typeof n === 'number' ? n.toFixed(1) : n;
}

// Inline-SVG sparkline with a filled area, baseline grid, and gap markers.
function Sparkline({ series }) {
  const vals = series.filter((v) => typeof v === 'number');
  const W = 800;
  const H = 120;
  if (vals.length < 2) {
    return (
      <div className="h-32 rounded-lg border border-edge bg-ink flex items-center justify-center text-slate-600 text-xs">
        <span className="flex items-center gap-2"><Icon name="activity" size={14} /> collecting samples…</span>
      </div>
    );
  }
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const pad = 6;
  const x = (i) => (i / (series.length - 1)) * W;
  const y = (v) => H - pad - ((v - min) / span) * (H - 2 * pad);
  const pts = series.map((v, i) => ({ x: x(i), y: typeof v === 'number' ? y(v) : H, gap: typeof v !== 'number' }));
  const line = pts.map((p, i) => `${i === 0 || pts[i - 1].gap ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPts = pts.filter((p) => !p.gap);
  const area = areaPts.length
    ? `M${areaPts[0].x.toFixed(1)},${H} ` + areaPts.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ` L${areaPts[areaPts.length - 1].x.toFixed(1)},${H} Z`
    : '';
  return (
    <div className="rounded-lg border border-edge bg-ink p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-32" preserveAspectRatio="none">
        <defs>
          <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="#1e2a37" strokeWidth="1" />
        ))}
        {area && <path d={area} fill="url(#spark)" />}
        <path d={line} fill="none" stroke="#34d399" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {pts.map((p, i) => (p.gap ? <circle key={i} cx={p.x} cy={H - 4} r="3" fill="#f43f5e" /> : null))}
      </svg>
    </div>
  );
}

// Write panel (§4.1): the double-gate flow, shown as a two-step gate.
export function WritePanel({ driver }) {
  const { session, armed, flash } = useStore();
  const [params, setParams] = useState(() => defaultsFor(driver.params?.write));
  const [prep, setPrep] = useState(null);
  const [result, setResult] = useState(null);
  useEffect(() => setParams(defaultsFor(driver.params?.write)), [driver.id]);

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
    <div className="max-w-4xl animate-fade-in">
      {/* Gate status strip */}
      <div className="flex items-center gap-2 mb-4 text-xs">
        <GateStep n={1} label="ARM session" done={armed} icon="bolt" />
        <div className={`h-px w-8 ${armed ? 'bg-hazard' : 'bg-edge'}`} />
        <GateStep n={2} label="Confirm write" done={!!result} icon="ok" active={armed} />
      </div>

      <div className="rounded-lg border border-hazard/30 bg-hazard/[0.05] px-4 py-3 mb-4 text-[13px] text-amber-200/90 leading-relaxed">
        Writes clear two gates: <b>ARM</b> the session (top bar, Gate 1), then <b>confirm</b> each write showing
        current → proposed (Gate 2). Every write is audited — non-disableable.
      </div>

      <ParamForm spec={driver.params?.write} value={params} onChange={setParams} />
      <Btn onClick={prepare} disabled={!session} icon="file">Dry-run / preview</Btn>

      {prep && (
        <div className="mt-4 rounded-lg border border-edge bg-panel p-4">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-1.5">
            <Icon name="shield" size={13} /> Confirm write · Gate 2
          </div>
          <KV
            pairs={[
              ['Target', prep.target],
              ['Point', prep.point],
              ['Current value', String(prep.current_value ?? '—')],
            ]}
          />
          <div className="flex items-center gap-2 my-3 text-sm">
            <span className="font-mono text-slate-400">{String(prep.current_value ?? '—')}</span>
            <Icon name="arrowRight" size={16} className="text-hazard" />
            <span className="font-mono font-semibold text-hazard">{String(prep.proposed_value)}</span>
          </div>
          {!armed && (
            <div className="flex items-center gap-2 text-xs text-rose-400 mb-3">
              <Icon name="warn" size={14} /> Session is READ-ONLY — ARM it in the top bar to enable this write.
            </div>
          )}
          <div className="flex gap-2">
            <Btn variant="hazard" onClick={confirm} disabled={!armed} icon="bolt">Commit write</Btn>
            <Btn variant="ghost" onClick={() => setPrep(null)}>Cancel</Btn>
          </div>
        </div>
      )}

      {result && (
        <div className="mt-4">
          <div className={`flex items-center gap-2 text-sm mb-2 ${result.result?.verified ? 'text-emerald-400' : 'text-amber-400'}`}>
            <Icon name={result.result?.verified ? 'ok' : 'warn'} size={16} />
            {result.result?.ack ? 'ACK received' : 'no ACK'} · read-back {String(result.result?.read_back ?? '—')} ·{' '}
            {result.result?.verified ? 'verified' : 'not verified'}
          </div>
          <Json data={result.result} />
        </div>
      )}
    </div>
  );
}

function GateStep({ n, label, done, active, icon }) {
  return (
    <div className={`flex items-center gap-1.5 ${done ? 'text-hazard' : active ? 'text-slate-300' : 'text-slate-500'}`}>
      <span className={`grid place-items-center h-5 w-5 rounded-full border text-[10px] font-semibold ${
        done ? 'bg-hazard text-black border-hazard' : active ? 'border-slate-400' : 'border-edge2'
      }`}>
        {done ? <Icon name={icon} size={11} strokeWidth={2.5} /> : n}
      </span>
      {label}
    </div>
  );
}

// Raw tab: hex dump of the most recent artifact from the evidence stream.
export function RawPanel() {
  const artifacts = useStore((s) => s.artifacts);
  const latest = artifacts[0];
  return (
    <div className="max-w-4xl animate-fade-in">
      <div className="flex items-start gap-3 mb-4 rounded-lg border border-edge bg-white/[0.02] px-4 py-3">
        <Icon name="copy" size={16} className="text-slate-500 mt-0.5" />
        <p className="text-[13px] text-slate-400 leading-relaxed">
          The actual bytes on the wire for the most recent action — so you can verify the tool isn't lying. Pulled from
          the evidence store.
        </p>
      </div>
      {latest ? (
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
            <Badge tone="emerald" className="capitalize">{latest.verb}</Badge>
            {latest.verdicts?.[0] && <SeverityChip severity={latest.verdicts[0].severity} />}
            <span className="font-mono text-slate-600">{latest.id}</span>
          </div>
          <HexView raw={latest.raw} />
        </div>
      ) : (
        <EmptyState title="No bytes captured yet" icon="copy">Run a verb to capture the raw frame.</EmptyState>
      )}
    </div>
  );
}
