import React from 'react';
import { useStore } from '../store.js';

// HOME (§7): overview of protocols ready + the loaded rulepacks. Doubles as the
// protocol catalog — every driver, its domain, library maturity, and focus.
const DOMAIN_LABEL = {
  it: 'IT / network',
  industrial: 'Industrial Ethernet',
  utility: 'Utility / building / energy',
  iiot: 'IIoT / broker / data',
  'iot-rf': 'IoT / wireless',
};

export default function Home({ setView }) {
  const { drivers, rulepacks, selectDriver } = useStore();
  const byDomain = {};
  for (const d of drivers) (byDomain[d.domain] ||= []).push(d);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="text-lg font-semibold text-slate-100 mb-1">Fieldscope</h1>
      <p className="text-sm text-slate-400 max-w-2xl mb-6">
        A read-only, evidence-first diagnostics workbench. Every probe, poll, and browse is captured
        as an artifact with raw bytes, a decode, and a verdict — then replayed, diffed, and exported.
        This build ships the IT tier plus Modbus TCP; the driver contract is the same for every
        protocol added next.
      </p>

      <div className="grid grid-cols-3 gap-3 mb-8 max-w-2xl">
        <Stat n={drivers.length} label="protocols ready" />
        <Stat n={rulepacks.reduce((a, p) => a + p.rules, 0)} label="diagnostic rules" />
        <Stat n={drivers.filter((d) => d.write_capable).length} label="write-capable (gated)" />
      </div>

      {Object.entries(byDomain).map(([domain, ds]) => (
        <div key={domain} className="mb-6">
          <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">{DOMAIN_LABEL[domain] || domain}</div>
          <div className="border border-edge rounded overflow-hidden">
            <table className="w-full text-sm">
              <tbody>
                {ds.map((d) => (
                  <tr
                    key={d.id}
                    onClick={() => { selectDriver(d.id); setView('workspace'); }}
                    className="border-b border-edge/50 hover:bg-panel cursor-pointer"
                  >
                    <td className="px-3 py-2 text-slate-200 w-48">{d.display_name}</td>
                    <td className="px-3 py-2 w-10">{d.lib}</td>
                    <td className="px-3 py-2 text-slate-500 text-xs">{d.describe}</td>
                    <td className="px-3 py-2 text-right w-40">
                      <span className="text-[10px] text-slate-500">{d.verbs.join(' · ')}</span>
                    </td>
                    <td className="px-3 py-2 w-8 text-hazard/70">{d.write_capable ? '✎' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function Stat({ n, label }) {
  return (
    <div className="rounded border border-edge bg-panel2 p-3">
      <div className="text-2xl font-semibold text-slate-100">{n}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}
