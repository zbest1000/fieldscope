import React, { useState } from 'react';
import { useStore } from '../store.js';
import { SEV_STYLE } from './ui.jsx';

// Persistent evidence drawer (§7). Every verb call is an artifact; they stream in
// here against the session timeline, most-recent first.
export default function EvidenceDrawer() {
  const { artifacts, session } = useStore();
  const [open, setOpen] = useState(true);

  return (
    <div className="border-t border-edge bg-panel2 shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-4 py-1.5 text-xs text-slate-400 hover:text-slate-200"
      >
        <span className="uppercase tracking-wider">Evidence</span>
        <span className="text-slate-500">{artifacts.length} artifacts</span>
        {session && <span className="text-slate-600 font-mono ml-2">{session.id}</span>}
        <span className="ml-auto">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="max-h-44 overflow-y-auto">
          {artifacts.length === 0 ? (
            <div className="px-4 py-3 text-slate-600 text-sm">No artifacts yet.</div>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {artifacts.map((a) => {
                  const top = a.verdicts?.[0];
                  const sev = top ? SEV_STYLE[top.severity] : null;
                  return (
                    <tr key={a.id} className="border-b border-edge/40 hover:bg-panel">
                      <td className="px-4 py-1 font-mono text-slate-500 w-8">#{a.seq}</td>
                      <td className="px-2 py-1 text-slate-300 capitalize w-24">{a.verb}</td>
                      <td className="px-2 py-1">
                        {top ? (
                          <span className={`inline-flex items-center gap-1.5 ${sev.text}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${sev.dot}`} />
                            {top.title}
                          </span>
                        ) : a.error ? (
                          <span className="text-rose-400">{a.error}</span>
                        ) : (
                          <span className="text-slate-500">{summ(a.result)}</span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-slate-600 font-mono w-16 text-right">{a.has_raw ? 'raw' : ''}</td>
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
