import React from 'react';
import { useStore } from '../store.js';
import { Icon, Badge } from './ui.jsx';

// HOME (§7): overview of protocols ready + loaded rulepacks. Doubles as the
// protocol catalog — every driver, its domain, library maturity, and focus.
const DOMAINS = [
  { key: 'it', label: 'IT / Network', accent: 'text-d-it', ring: 'bg-d-it' },
  { key: 'industrial', label: 'Industrial Ethernet', accent: 'text-d-industrial', ring: 'bg-d-industrial' },
  { key: 'utility', label: 'Utility / Building / Energy', accent: 'text-d-utility', ring: 'bg-d-utility' },
  { key: 'iiot', label: 'IIoT / Broker / Data', accent: 'text-d-iiot', ring: 'bg-d-iiot' },
  { key: 'iot-rf', label: 'IoT / Wireless', accent: 'text-d-rf', ring: 'bg-d-rf' },
];

export default function Home({ setView }) {
  const { drivers, rulepacks, selectDriver } = useStore();
  const byDomain = {};
  for (const d of drivers) (byDomain[d.domain] ||= []).push(d);
  const totalRules = rulepacks.reduce((a, p) => a + p.rules, 0);

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Hero */}
      <div className="px-8 pt-8 pb-6 border-b border-edge bg-gradient-to-b from-emerald-500/[0.04] to-transparent">
        <h1 className="text-2xl font-semibold text-slate-100 tracking-tight">Fieldscope</h1>
        <p className="text-sm text-slate-400 max-w-2xl mt-2 leading-relaxed">
          A read-only, evidence-first diagnostics workbench. Every probe, poll, and browse is captured as an artifact
          with raw bytes, a decode, and a plain-English verdict — then replayed, diffed, and exported. One workbench
          spanning IT, industrial, utility, and IIoT behind a single driver contract; writes are double-gated and every
          action is audited.
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 max-w-3xl">
          <Stat icon="layers" n={drivers.length} label="protocols ready" tone="text-emerald-400" />
          <Stat icon="shield" n={totalRules} label="diagnostic rules" tone="text-sky-400" />
          <Stat icon="bolt" n={drivers.filter((d) => d.write_capable).length} label="write-capable · gated" tone="text-hazard" />
          <Stat icon="activity" n={DOMAINS.filter((d) => byDomain[d.key]?.length).length} label="protocol tiers" tone="text-violet-400" />
        </div>

        <div className="flex flex-wrap items-center gap-4 mt-5 text-[11px] text-slate-500">
          <span className="uppercase tracking-wider">Legend</span>
          <span className="flex items-center gap-1.5">🟢 mature library</span>
          <span className="flex items-center gap-1.5">🟡 partial</span>
          <span className="flex items-center gap-1.5">🔴 decode-only</span>
          <span className="flex items-center gap-1.5"><Icon name="bolt" size={12} className="text-hazard" /> write-capable (ARM-gated)</span>
        </div>
      </div>

      {/* Catalog */}
      <div className="p-8 space-y-8">
        {DOMAINS.filter((dom) => byDomain[dom.key]?.length).map((dom) => (
          <section key={dom.key}>
            <div className="flex items-center gap-2 mb-3">
              <span className={`h-2 w-2 rounded-full ${dom.ring}`} />
              <h2 className={`text-xs font-semibold uppercase tracking-wider ${dom.accent}`}>{dom.label}</h2>
              <span className="text-xs text-slate-600">{byDomain[dom.key].length}</span>
            </div>
            <div className="rounded-lg border border-edge overflow-hidden divide-y divide-edge/60">
              {byDomain[dom.key].map((d) => (
                <button
                  key={d.id}
                  onClick={() => { selectDriver(d.id); setView('workspace'); }}
                  className="group w-full text-left flex items-center gap-4 px-4 py-3 hover:bg-white/[0.03]"
                >
                  <div className="w-52 shrink-0">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-100 font-medium">{d.display_name}</span>
                      {d.write_capable && <Icon name="bolt" size={13} className="text-hazard/70" />}
                    </div>
                    <div className="text-[11px] text-slate-600 font-mono mt-0.5">{d.id}{d.default_port ? ` · :${d.default_port}` : ''}</div>
                  </div>
                  <span className="w-7 text-center shrink-0">{d.lib?.slice(0, 2)}</span>
                  <div className="flex-1 min-w-0 text-xs text-slate-500 truncate">{d.describe}</div>
                  <div className="hidden lg:flex flex-wrap gap-1 justify-end w-64 shrink-0">
                    {d.verbs.filter((v) => v !== 'decode').map((v) => (
                      <span
                        key={v}
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          v === 'diagnose'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : v === 'write'
                              ? 'bg-hazard/10 text-hazard'
                              : 'bg-white/5 text-slate-400'
                        }`}
                      >
                        {v}
                      </span>
                    ))}
                  </div>
                  <Icon name="arrowRight" size={15} className="text-slate-600 group-hover:text-slate-300 shrink-0" />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function Stat({ icon, n, label, tone }) {
  return (
    <div className="rounded-lg border border-edge bg-panel p-3.5 shadow-card">
      <div className="flex items-center justify-between">
        <div className="text-3xl font-semibold text-slate-100 tabular-nums">{n}</div>
        <Icon name={icon} size={18} className={tone} />
      </div>
      <div className="text-[11px] text-slate-500 mt-1">{label}</div>
    </div>
  );
}
