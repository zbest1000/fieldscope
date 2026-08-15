import React, { useState } from 'react';

// ---------------------------------------------------------------------------
// Icon set — small inline SVGs (no icon library; offline-first). 1.75 stroke,
// currentColor, 16px default. Add a path by name to `PATHS`.
// ---------------------------------------------------------------------------
const PATHS = {
  ok: 'M20 6 9 17l-5-5',
  info: 'M12 16v-5M12 8h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  warn: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01',
  error: 'M12 8v4M12 16h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  search: 'm21 21-4.3-4.3M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z',
  copy: 'M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z',
  download: 'M12 3v12m0 0 4-4m-4 4-4-4M4 21h16',
  play: 'M6 4l14 8-14 8V4Z',
  stop: 'M6 6h12v12H6z',
  arrowRight: 'M5 12h14m-6-6 6 6-6 6',
  chevron: 'm6 9 6 6 6-6',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
  shield: 'M12 3l7 3v6c0 5-3.5 8-7 9-3.5-1-7-4-7-9V6l7-3Z',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  plug: 'M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0V8ZM12 16v6',
  wifi: 'M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01',
  layers: 'm12 2 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 17l9 5 9-5',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  x: 'M18 6 6 18M6 6l12 12',
  dot: 'M12 12h.01',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  file: 'M14 3v5h5M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-5Z',
};

export function Icon({ name, size = 16, className = '', strokeWidth = 1.75, fill = 'none' }) {
  const d = PATHS[name] || PATHS.dot;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {d.split('M').filter(Boolean).map((seg, i) => (
        <path key={i} d={`M${seg}`} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Severity system
// ---------------------------------------------------------------------------
export const SEV_STYLE = {
  ok: { icon: 'ok', dot: 'bg-emerald-500', text: 'text-emerald-400', border: 'border-emerald-500/40', bg: 'bg-emerald-500/10', bar: 'bg-emerald-500', ring: 'ring-emerald-500/30' },
  info: { icon: 'info', dot: 'bg-sky-500', text: 'text-sky-400', border: 'border-sky-500/40', bg: 'bg-sky-500/10', bar: 'bg-sky-500', ring: 'ring-sky-500/30' },
  warn: { icon: 'warn', dot: 'bg-amber-500', text: 'text-amber-400', border: 'border-amber-500/40', bg: 'bg-amber-500/10', bar: 'bg-amber-500', ring: 'ring-amber-500/30' },
  error: { icon: 'error', dot: 'bg-rose-500', text: 'text-rose-400', border: 'border-rose-500/40', bg: 'bg-rose-500/10', bar: 'bg-rose-500', ring: 'ring-rose-500/30' },
};

export function SeverityChip({ severity }) {
  const s = SEV_STYLE[severity] || SEV_STYLE.info;
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${s.text} ${s.bg}`}>
      <Icon name={s.icon} size={11} strokeWidth={2.25} />
      {severity}
    </span>
  );
}

// A verdict card (§5, §7 Diagnose): a left severity bar, icon, title chip,
// detail, and next steps.
export function Verdict({ v }) {
  const s = SEV_STYLE[v.severity] || SEV_STYLE.info;
  return (
    <div className={`relative overflow-hidden rounded-lg border ${s.border} ${s.bg} pl-4 pr-4 py-3 mb-2.5 animate-fade-in`}>
      <span className={`absolute left-0 top-0 h-full w-1 ${s.bar}`} />
      <div className="flex items-start gap-2.5">
        <span className={`mt-0.5 ${s.text}`}><Icon name={s.icon} size={18} strokeWidth={2} /></span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`font-semibold ${s.text}`}>{v.title}</span>
            <SeverityChip severity={v.severity} />
          </div>
          {v.detail && <p className="text-[13px] leading-relaxed text-slate-300 mt-1.5 whitespace-pre-wrap">{v.detail}</p>}
          {v.next_steps?.length > 0 && (
            <div className="mt-2.5 rounded-md bg-black/20 border border-white/5 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Next steps</div>
              <ul className="space-y-1">
                {v.next_steps.map((n, i) => (
                  <li key={i} className="flex gap-2 text-[13px] text-slate-300">
                    <span className={`mt-1.5 h-1 w-1 rounded-full shrink-0 ${s.bar}`} />
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
const BTN_VARIANTS = {
  default: 'bg-raised/60 border-edge2 text-slate-200 hover:bg-raised hover:border-slate-500',
  primary: 'bg-emerald-600 border-emerald-500 text-white hover:bg-emerald-500 shadow-sm shadow-emerald-900/40',
  hazard: 'bg-hazard border-hazard text-black font-semibold hover:brightness-110',
  ghost: 'bg-transparent border-transparent text-slate-400 hover:text-slate-100 hover:bg-white/5',
  subtle: 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10',
};
const BTN_SIZES = { sm: 'px-2.5 py-1 text-xs', md: 'px-3.5 py-1.5 text-sm', lg: 'px-4 py-2 text-sm' };

export function Btn({ children, onClick, disabled, busy, variant = 'default', size = 'md', icon, className = '', ...rest }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md border font-medium disabled:opacity-40 disabled:cursor-not-allowed ${BTN_VARIANTS[variant]} ${BTN_SIZES[size]} ${className}`}
      {...rest}
    >
      {busy ? <Spinner size={14} /> : icon ? <Icon name={icon} size={size === 'sm' ? 13 : 15} /> : null}
      {children}
    </button>
  );
}

export function Spinner({ size = 16, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`animate-spin ${className}`} aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------
export function Field({ label, children, hint }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-slate-600">{hint}</span>}
    </label>
  );
}

const INPUT_CLASS =
  'bg-ink border border-edge rounded-md px-2.5 py-1.5 text-sm text-slate-100 placeholder-slate-600 focus:border-emerald-500/60 hover:border-edge2';

export function Input({ className = '', ...rest }) {
  return <input className={`${INPUT_CLASS} ${className}`} {...rest} />;
}
export function Select({ className = '', children, ...rest }) {
  return (
    <select className={`${INPUT_CLASS} pr-7 ${className}`} {...rest}>
      {children}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Layout atoms
// ---------------------------------------------------------------------------
export function Card({ children, className = '' }) {
  return <div className={`rounded-lg border border-edge bg-panel shadow-card ${className}`}>{children}</div>;
}

export function Badge({ children, tone = 'slate', className = '' }) {
  const tones = {
    slate: 'bg-white/5 text-slate-400 border-white/10',
    emerald: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    amber: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    hazard: 'bg-hazard/15 text-hazard border-hazard/30',
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${tones[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function EmptyState({ icon = 'layers', title, children }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6 animate-fade-in">
      <div className="mb-3 grid place-items-center h-12 w-12 rounded-full bg-white/5 text-slate-500">
        <Icon name={icon} size={22} />
      </div>
      <div className="text-slate-300 font-medium">{title}</div>
      {children && <div className="text-sm text-slate-500 mt-1 max-w-sm">{children}</div>}
    </div>
  );
}

export function Kbd({ children }) {
  return <kbd className="rounded border border-edge2 bg-ink px-1.5 py-0.5 text-[10px] font-mono text-slate-400">{children}</kbd>;
}

// ---------------------------------------------------------------------------
// Copy button + data views
// ---------------------------------------------------------------------------
export function CopyButton({ text, className = '' }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        try {
          navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch { /* clipboard blocked */ }
      }}
      className={`inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 ${className}`}
      title="Copy"
    >
      <Icon name={copied ? 'ok' : 'copy'} size={12} />
      {copied ? 'copied' : 'copy'}
    </button>
  );
}

// Hex + ASCII dump for the Raw tab (§7, "verify the tool"). Renders a proper
// offset / hex / ascii dump so the bytes are actually readable.
export function HexView({ raw }) {
  if (!raw) return <div className="text-slate-500 text-sm">No raw bytes captured for this artifact.</div>;
  const blocks = [];
  if (raw.tx) blocks.push(['TX', raw.tx]);
  if (raw.rx) blocks.push(['RX', raw.rx]);
  if (raw.setup_tx) blocks.push(['SETUP TX', raw.setup_tx]);
  if (raw.setup_rx) blocks.push(['SETUP RX', raw.setup_rx]);
  if (raw.szl_rx) blocks.push(['SZL RX', raw.szl_rx]);
  if (raw.hex) blocks.push(['BYTES', raw.hex]);
  if (raw.text) blocks.push(['TEXT', null, raw.text]);
  return (
    <div className="space-y-3">
      {blocks.map(([label, hex, text], i) => (
        <div key={i}>
          <div className="flex items-center gap-2 mb-1">
            <Badge tone={label.includes('TX') ? 'emerald' : 'slate'}>{label}</Badge>
            {hex && <span className="text-[10px] text-slate-600">{hex.length / 2} bytes</span>}
            {hex && <CopyButton text={hex} className="ml-auto" />}
          </div>
          {hex ? (
            <HexDump hex={hex} />
          ) : (
            <pre className="hex bg-ink border border-edge rounded-md p-3 text-slate-300 whitespace-pre-wrap">{text}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

function HexDump({ hex }) {
  const bytes = hex.match(/.{1,2}/g) || [];
  const rows = [];
  for (let i = 0; i < bytes.length; i += 16) rows.push(bytes.slice(i, i + 16));
  return (
    <div className="hex bg-ink border border-edge rounded-md p-3 overflow-x-auto">
      {rows.map((row, r) => {
        const ascii = row
          .map((b) => {
            const c = parseInt(b, 16);
            return c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '.';
          })
          .join('');
        return (
          <div key={r} className="flex gap-4 whitespace-pre">
            <span className="text-slate-600 select-none">{(r * 16).toString(16).padStart(4, '0')}</span>
            <span className="text-emerald-300">
              {row.map((b, i) => (
                <span key={i}>{b}{i === 7 ? '  ' : ' '}</span>
              ))}
              {row.length < 16 && ' '.repeat((16 - row.length) * 3 + (row.length <= 7 ? 1 : 0))}
            </span>
            <span className="text-slate-500">{ascii}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Json({ data }) {
  const text = JSON.stringify(data, null, 2);
  return (
    <div className="relative group">
      <CopyButton text={text} className="absolute right-2 top-2 opacity-0 group-hover:opacity-100" />
      <pre className="hex bg-ink border border-edge rounded-md p-3 text-slate-300 overflow-x-auto whitespace-pre-wrap">{text}</pre>
    </div>
  );
}

// A small key/value grid for compact result rendering.
export function KV({ pairs }) {
  return (
    <div className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
      {pairs.map(([k, v], i) => (
        <React.Fragment key={i}>
          <div className="text-slate-500">{k}</div>
          <div className="font-mono text-slate-200 break-all">{v}</div>
        </React.Fragment>
      ))}
    </div>
  );
}
