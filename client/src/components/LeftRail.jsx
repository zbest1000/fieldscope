import React, { useMemo, useState } from 'react';
import { useStore } from '../store.js';
import { Icon, Input } from './ui.jsx';

// Left-rail workspace navigation (§7). Drivers grouped by domain; the active one
// drives which workspace renders. A search box filters the whole catalog.
const GROUP_LABELS = {
  discovery: 'Discovery',
  tools: 'Tools',
  industrial: 'Industrial',
  utility: 'Utility',
  iiot: 'IIoT',
  'iot-rf': 'Wireless / IoT',
};
const GROUP_ORDER = ['discovery', 'industrial', 'utility', 'iiot', 'iot-rf', 'tools'];

// Domain accent for the status dot.
const DOMAIN_DOT = {
  it: 'bg-d-it',
  industrial: 'bg-d-industrial',
  utility: 'bg-d-utility',
  iiot: 'bg-d-iiot',
  'iot-rf': 'bg-d-rf',
};

export default function LeftRail({ view, setView }) {
  const { grouped, activeDriverId, selectDriver, session } = useStore();
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState({});

  const query = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    const out = {};
    for (const g of GROUP_ORDER) {
      const list = (grouped[g] || []).filter(
        (d) => !query || d.display_name.toLowerCase().includes(query) || d.id.includes(query),
      );
      if (list.length) out[g] = list;
    }
    return out;
  }, [grouped, query]);
  const groups = Object.keys(filtered);

  return (
    <div className="w-64 shrink-0 border-r border-edge bg-panel2 flex flex-col text-sm">
      <div className="p-2 flex flex-col gap-1 border-b border-edge">
        <NavItem icon="layers" label="Home" active={view === 'home'} onClick={() => setView('home')} />
        <NavItem icon="file" label="Evidence" active={view === 'evidence'} onClick={() => setView('evidence')} />
      </div>

      <div className="p-2 border-b border-edge">
        <div className="relative">
          <Icon name="search" size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter protocols…"
            className="w-full pl-8 py-1.5"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {groups.length === 0 && <div className="px-3 py-6 text-center text-xs text-slate-600">No protocol matches “{q}”.</div>}
        {groups.map((g) => {
          const isCollapsed = collapsed[g];
          return (
            <div key={g} className="mb-1">
              <button
                onClick={() => setCollapsed((c) => ({ ...c, [g]: !c[g] }))}
                className="w-full flex items-center gap-1.5 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-300"
              >
                <Icon name="chevron" size={12} className={`transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                {GROUP_LABELS[g] || g}
                <span className="ml-auto text-slate-600 font-normal">{filtered[g].length}</span>
              </button>
              {!isCollapsed &&
                filtered[g].map((d) => {
                  const active = view === 'workspace' && activeDriverId === d.id;
                  const isSession = session?.driver_id === d.id;
                  return (
                    <button
                      key={d.id}
                      onClick={() => {
                        selectDriver(d.id);
                        setView('workspace');
                      }}
                      className={`group w-full text-left pl-3 pr-2.5 py-1.5 flex items-center gap-2.5 border-l-2 ${
                        active
                          ? 'bg-white/5 text-slate-100 border-emerald-500'
                          : 'text-slate-400 border-transparent hover:bg-white/[0.03] hover:text-slate-200'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${DOMAIN_DOT[d.domain] || 'bg-slate-600'}`} />
                      <span className="flex-1 truncate">{d.display_name}</span>
                      {isSession && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" title="live session" />}
                      {d.write_capable && <Icon name="bolt" size={12} className="text-hazard/70" />}
                      {d.mode === 'observe' && <span className="text-[9px] text-slate-600 uppercase">obs</span>}
                    </button>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NavItem({ icon, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm font-medium ${
        active ? 'bg-white/5 text-slate-100' : 'text-slate-400 hover:bg-white/[0.03] hover:text-slate-200'
      }`}
    >
      <Icon name={icon} size={16} />
      {label}
    </button>
  );
}
