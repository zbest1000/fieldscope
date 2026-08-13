import React from 'react';
import { useStore } from '../store.js';

// Left-rail workspace navigation (§7). Drivers grouped by domain; the active one
// drives which workspace renders. HOME shows the protocol catalog.
const GROUP_LABELS = {
  discovery: '▾ DISCOVERY',
  tools: '▾ TOOLS',
  industrial: '▾ INDUSTRIAL PROTOCOLS',
  utility: '▾ UTILITY',
  iiot: '▾ IIoT',
  'iot-rf': '▾ WIRELESS / IoT',
};
const GROUP_ORDER = ['discovery', 'industrial', 'utility', 'iiot', 'iot-rf', 'tools'];

export default function LeftRail({ view, setView }) {
  const { grouped, activeDriverId, selectDriver } = useStore();
  const groups = GROUP_ORDER.filter((g) => grouped[g]?.length);

  return (
    <div className="w-60 shrink-0 border-r border-edge bg-panel2 overflow-y-auto text-sm">
      <RailItem label="HOME" active={view === 'home'} onClick={() => setView('home')} />
      <RailItem label="EVIDENCE" active={view === 'evidence'} onClick={() => setView('evidence')} />

      {groups.map((g) => (
        <div key={g} className="mt-3">
          <div className="px-3 py-1 text-[11px] tracking-wider text-slate-500">
            {GROUP_LABELS[g] || `▾ ${g.toUpperCase()}`}
          </div>
          {grouped[g].map((d) => (
            <button
              key={d.id}
              onClick={() => {
                selectDriver(d.id);
                setView('workspace');
              }}
              className={`w-full text-left pl-6 pr-3 py-1.5 flex items-center gap-2 hover:bg-panel ${
                view === 'workspace' && activeDriverId === d.id
                  ? 'bg-panel text-slate-100 border-l-2 border-emerald-500'
                  : 'text-slate-400 border-l-2 border-transparent'
              }`}
            >
              <span className="flex-1">{d.display_name}</span>
              {d.write_capable && <span className="text-[10px] text-hazard/70" title="write-capable">✎</span>}
              {d.lib && <span className="text-[10px]">{d.lib.slice(0, 2)}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function RailItem({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 tracking-wide text-xs font-semibold hover:bg-panel ${
        active ? 'bg-panel text-slate-100' : 'text-slate-400'
      }`}
    >
      {label}
    </button>
  );
}
