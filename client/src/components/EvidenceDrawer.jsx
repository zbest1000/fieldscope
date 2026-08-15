import React, { useState } from 'react';
import { useStore } from '../store.js';
import { SEV_STYLE, Icon, SeverityChip } from './ui.jsx';

// Persistent evidence drawer (§7). Every verb call is an artifact; they stream in
// here against the session timeline, most-recent first.
export default function EvidenceDrawer() {
  const { artifacts, session } = useStore();
  const [open, setOpen] = useState(true);

  return (
    <div className="border-t border-edge bg-panel2 shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-4 py-2 text-xs text-slate-400 hover:text-slate-200"
      >
        <Icon name="file" size={13} className="text-slate-500" />
        <span className="uppercase tracking-wider font-semibold">Evidence</span>
        <span className="rounded bg-white/5 px-1.5 py-0.5 text-slate-400">{artifacts.length}</span>
        {session && <span className="text-slate-600 font-mono ml-1">{session.id}</span>}
        <Icon name="chevron" size={14} className={`ml-auto transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="max-h-48 overflow-y-auto border-t border-edge/60">
          {artifacts.length === 0 ? (
            <div className="px-4 py-4 text-slate-600 text-sm flex items-center gap-2">
              <Icon name="clock" size={14} /> No artifacts yet — run a verb to capture evidence.
            </div>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {artifacts.map((a) => {
                  const top = a.verdicts?.[0];
                  const sev = top ? SEV_STYLE[top.severity] : null;
                  return (
                    <tr key={a.id} className="border-b border-edge/40 hover:bg-white/[0.02]">
                      <td className="px-4 py-1.5 font-mono text-slate-600 w-10">#{a.seq}</td>
                      <td className="px-2 py-1.5 text-slate-300 capitalize w-24 font-medium">{a.verb}</td>
                      <td className="px-2 py-1.5">
                        {top ? (
                          <span className={`inline-flex items-center gap-1.5 ${sev.text}`}>
                            <Icon name={sev.icon} size={12} strokeWidth={2.25} />
                            {top.title}
                          </span>
                        ) : a.error ? (
                          <span className="text-rose-400">{a.error}</span>
                        ) : (
                          <span className="text-slate-500">{summ(a.result)}</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right w-16">
                        {a.has_raw && <span className="text-[10px] text-emerald-500/70 font-mono">raw</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function summ(result) {
  if (!result) return '';
  if (result.values) return `values: [${result.values.slice(0, 6).join(', ')}${result.values.length > 6 ? '…' : ''}]`;
  if (result.state) return `state: ${result.state}`;
  if (result.reachable !== undefined) return result.reachable ? 'reachable' : 'unreachable';
  const keys = Object.keys(result).slice(0, 3);
  return keys.map((k) => `${k}: ${JSON.stringify(result[k])}`).join(' · ');
}
