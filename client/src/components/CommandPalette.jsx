import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store.js';
import { Icon, Kbd } from './ui.jsx';

// Command palette (⌘K / Ctrl-K): a keyboard-first quick switcher over every
// driver plus the top-level views. With ~20 protocols the rail search is fine
// for browsing, but a spotlight-style jump-to is the fastest path when you know
// the name — the standard pattern for tools with many destinations. Fully
// keyboard driven (↑/↓ to move, ↵ to open, esc to close) and offline (no deps).

const DOMAIN_DOT = {
  it: 'bg-d-it',
  industrial: 'bg-d-industrial',
  utility: 'bg-d-utility',
  iiot: 'bg-d-iiot',
  'iot-rf': 'bg-d-rf',
};

export default function CommandPalette({ setView }) {
  const { drivers, selectDriver, session } = useStore();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Global ⌘K / Ctrl-K to toggle; the handler lives for the app's lifetime.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Reset query/selection and focus the field each time it opens.
  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items = useMemo(() => {
    const nav = [
      { kind: 'view', id: 'home', label: 'Home', sub: 'protocol catalog', icon: 'layers' },
      { kind: 'view', id: 'evidence', label: 'Evidence', sub: 'sessions · replay · diff · audit', icon: 'file' },
    ];
    const drv = drivers.map((d) => ({
      kind: 'driver',
      id: d.id,
      label: d.display_name,
      sub: `${d.id}${d.default_port ? ` · :${d.default_port}` : ''}${d.describe ? ` — ${d.describe}` : ''}`,
      domain: d.domain,
      write: d.write_capable,
      live: session?.driver_id === d.id,
    }));
    const query = q.trim().toLowerCase();
    const all = [...nav, ...drv];
    if (!query) return all;
    return all.filter((it) => it.label.toLowerCase().includes(query) || it.sub.toLowerCase().includes(query));
  }, [drivers, q, session]);

  useEffect(() => { if (sel >= items.length) setSel(Math.max(0, items.length - 1)); }, [items.length, sel]);

  function activate(it) {
    if (!it) return;
    if (it.kind === 'view') setView(it.id);
    else { selectDriver(it.id); setView('workspace'); }
    setOpen(false);
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); activate(items[sel]); }
  }

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${sel}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] px-4" onMouseDown={() => setOpen(false)}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" />
      <div
        className="relative w-full max-w-xl rounded-2xl border border-edge2 glass shadow-pop overflow-hidden animate-scale-in ring-1 ring-white/5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-3.5 border-b border-edge">
          <Icon name="search" size={16} className="text-slate-500 shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={onKeyDown}
            placeholder="Jump to a protocol or view…"
            className="flex-1 bg-transparent py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none"
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1.5">
          {items.length === 0 && (
            <div className="px-4 py-8 text-center text-xs text-slate-600">No protocol or view matches “{q}”.</div>
          )}
          {items.map((it, i) => (
            <button
              key={`${it.kind}:${it.id}`}
              data-idx={i}
              onMouseEnter={() => setSel(i)}
              onClick={() => activate(it)}
              className={`w-full text-left flex items-center gap-3 px-3.5 py-2 ${i === sel ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'}`}
            >
              {it.kind === 'view' ? (
                <Icon name={it.icon} size={15} className="text-slate-500 shrink-0" />
              ) : (
                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${DOMAIN_DOT[it.domain] || 'bg-slate-600'}`} />
              )}
              <span className="text-sm text-slate-200 shrink-0">{it.label}</span>
              <span className="text-[11px] text-slate-600 truncate flex-1 min-w-0">{it.sub}</span>
              {it.live && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" title="live session" />}
              {it.write && <Icon name="bolt" size={12} className="text-hazard/70 shrink-0" />}
              {i === sel && <Icon name="arrowRight" size={14} className="text-slate-400 shrink-0" />}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 px-3.5 py-2 border-t border-edge text-[10px] text-slate-600">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
          <span className="ml-auto flex items-center gap-1"><Kbd>⌘</Kbd><Kbd>K</Kbd> toggle</span>
        </div>
      </div>
    </div>
  );
}
