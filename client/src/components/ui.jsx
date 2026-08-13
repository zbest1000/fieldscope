import React from 'react';

export const SEV_STYLE = {
  ok: { dot: 'bg-emerald-500', text: 'text-emerald-400', border: 'border-emerald-800', bg: 'bg-emerald-950/40' },
  info: { dot: 'bg-sky-500', text: 'text-sky-400', border: 'border-sky-800', bg: 'bg-sky-950/40' },
  warn: { dot: 'bg-amber-500', text: 'text-amber-400', border: 'border-amber-800', bg: 'bg-amber-950/40' },
  error: { dot: 'bg-rose-500', text: 'text-rose-400', border: 'border-rose-800', bg: 'bg-rose-950/40' },
};

// A verdict card (§5, §7 Diagnose): severity color + title + detail + next steps.
export function Verdict({ v }) {
  const s = SEV_STYLE[v.severity] || SEV_STYLE.info;
  return (
    <div className={`rounded border ${s.border} ${s.bg} p-3 mb-2`}>
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${s.dot}`} />
        <span className={`font-semibold ${s.text}`}>{v.title}</span>
        <span className="text-[10px] uppercase tracking-wider text-slate-500 ml-auto">{v.severity}</span>
      </div>
      {v.detail && <p className="text-xs text-slate-300 mt-1.5 whitespace-pre-wrap">{v.detail}</p>}
      {v.next_steps?.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Next steps</div>
          <ul className="text-xs text-slate-300 list-disc list-inside space-y-0.5">
            {v.next_steps.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Hex + ASCII view for the Raw tab (§7, "verify the tool").
export function HexView({ raw }) {
  if (!raw) return <div className="text-slate-500 text-sm">No raw bytes captured for this artifact.</div>;
  const blocks = [];
  if (raw.tx) blocks.push(['TX', raw.tx]);
  if (raw.rx) blocks.push(['RX', raw.rx]);
  if (raw.hex) blocks.push(['BYTES', raw.hex]);
  if (raw.text) blocks.push(['TEXT', null, raw.text]);
  return (
    <div className="space-y-3">
      {blocks.map(([label, hex, text], i) => (
        <div key={i}>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{label}</div>
          {hex ? (
            <div className="hex bg-ink border border-edge rounded p-2 text-emerald-300">{groupHex(hex)}</div>
          ) : (
            <pre className="hex bg-ink border border-edge rounded p-2 text-slate-300 whitespace-pre-wrap">{text}</pre>
          )}
        </div>
      ))}
      {raw.ascii && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">ASCII</div>
          <div className="hex bg-ink border border-edge rounded p-2 text-slate-400">{raw.ascii}</div>
        </div>
      )}
    </div>
  );
}

function groupHex(hex) {
  return (hex.match(/.{1,2}/g) || []).join(' ');
}

export function Json({ data }) {
  return (
    <pre className="hex bg-ink border border-edge rounded p-2 text-slate-300 overflow-x-auto whitespace-pre-wrap">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

export function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wider text-slate-500">{label}</span>
      {children}
    </label>
  );
}

export function Btn({ children, onClick, disabled, variant = 'default', ...rest }) {
  const styles = {
    default: 'border-edge text-slate-200 hover:border-slate-500',
    primary: 'bg-emerald-600 border-emerald-600 text-white hover:brightness-110',
    hazard: 'bg-hazard border-hazard text-black hover:brightness-110',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 rounded text-sm border ${styles[variant]} disabled:opacity-40`}
      {...rest}
    >
      {children}
    </button>
  );
}
