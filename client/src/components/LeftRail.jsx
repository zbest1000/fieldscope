import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store.js';
import { Icon, Input, Kbd } from './ui.jsx';

// Open the command palette by re-emitting the global shortcut it listens for.
const openPalette = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));

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

const COLLAPSE_KEY = 'fieldscope.railCollapsed';

export default function LeftRail({ view, setView }) {
  const { grouped, activeDriverId, selectDriver, session } = useStore();
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
    } catch { /* storage blocked */ }
  }, [collapsed]);

  const query = q.trim().toLowerCase();
  const filtering = query.length > 0;
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
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed[g]);
  const toggleAll = () => {
    const next = {};
    if (!allCollapsed) for (const g of GROUP_ORDER) next[g] = true;
    setCollapsed(next);
  };

  return (
    <div className="w-64 shrink-0 border-r border-edge bg-panel2 flex flex-col text-sm">
      <div className="p-2 flex flex-col gap-1 border-b border-edge">
        <NavItem icon="layers" label="Home" active={view === 'home'} onClick={() => setView('home')} />
        <NavItem icon="file" label="Evidence" active={view === 'evidence'} onClick={() => setView('evidence')} />
      </div>

      <div className="p-2 border-b border-edge flex items-center gap-1.5">
        <div className="relative flex-1">
          <Icon name="search" size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter protocols…"
            className="w-full pl-8 pr-12 py-1.5"
          />
          <button
            onClick={openPalette}
            title="Open command palette (⌘K)"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 hover:opacity-100 opacity-70"
          >
            <Kbd>⌘K</Kbd>
          </button>
        </div>
        <button
          onClick={toggleAll}
          title={allCollapsed ? 'Expand all categories' : 'Collapse all categories'}
          className="shrink-0 grid place-items-center h-8 w-8 rounded-md border border-edge text-slate-500 hover:text-slate-200 hover:bg-white/5"
        >
          <Icon name="chevron" size={15} className={`transition-transform ${allCollapsed ? '-rotate-90' : ''}`} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {groups.length === 0 && <div className="px-3 py-6 text-center text-xs text-slate-600">No protocol matches “{q}”.</div>}
        {groups.map((g) => {
          const isCollapsed = collapsed[g] && !filtering; // filtering forces-expand matches
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
