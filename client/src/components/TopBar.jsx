import React, { useEffect, useState } from 'react';
import { useStore } from '../store.js';
import { Icon, Btn, Input, Kbd } from './ui.jsx';

// Global chrome (§7): brand, SOURCE adapter, session, state pill LIVE/READ-ONLY,
// ARM toggle. Arming re-colors the whole shell as a standing hazard indication
// and shows the auto-expiry countdown (§4.1).
export default function TopBar() {
  const { session, armed, armExpiresAt, arm, disarm, flash } = useStore();
  const [now, setNow] = useState(Date.now());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const driver = useStore((s) => s.activeDriver());
  const writeCapable = driver?.write_capable;
  const secsLeft = armExpiresAt ? Math.max(0, Math.round((armExpiresAt - now) / 1000)) : 0;

  async function doArm() {
    try {
      await arm(confirmText);
      setConfirmOpen(false);
      setConfirmText('');
    } catch (e) {
      flash(e.message);
    }
  }

  return (
    <div
      className={`relative z-30 flex items-center gap-4 px-4 h-14 border-b border-edge glass shadow-[0_1px_0_0_rgba(255,255,255,0.03),0_8px_24px_-16px_rgba(0,0,0,0.8)] text-sm shrink-0 ${
        armed ? 'armed-chrome bg-[#2a1f08]/85' : ''
      }`}
    >
      {/* Brand */}
      <div className="flex items-center gap-2.5">
        <div className={`grid place-items-center h-8 w-8 rounded-lg border shadow-inner-hi ${armed ? 'bg-btn-hazard text-black border-amber-300/60' : 'bg-gradient-to-b from-emerald-400/25 to-emerald-600/10 text-emerald-300 border-emerald-500/30 shadow-glow-accent'}`}>
          <Icon name="activity" size={18} strokeWidth={2.25} />
        </div>
        <div className="leading-tight">
          <div className="font-semibold tracking-wide text-slate-100">FIELDSCOPE</div>
          <div className="text-[10px] text-slate-500 -mt-0.5">Connected Core Industries</div>
        </div>
      </div>

      <div className="h-6 w-px bg-edge" />

      <div className="flex items-center gap-2 text-xs text-slate-400">
        <Icon name="wifi" size={14} className="text-slate-500" />
        <span className="text-slate-500">SOURCE</span>
        <span className="px-2 py-0.5 rounded bg-white/5 border border-edge text-slate-300">default NIC</span>
      </div>

      <div className="flex-1" />

      {session ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-slate-500">session</span>
          <span className="font-mono text-slate-300">{session.address || session.driver_id}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />
          no session
        </div>
      )}

      {/* LIVE / READ-ONLY state pill */}
      <span
        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border shadow-inner-hi ${
          armed ? 'bg-btn-hazard text-black border-amber-300/60 animate-pulse-hazard shadow-glow-hazard' : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
        }`}
      >
        <Icon name={armed ? 'bolt' : 'shield'} size={13} strokeWidth={2.25} />
        {armed ? 'LIVE-WRITE' : 'READ-ONLY'}
      </span>

      {/* ARM toggle — dark until deliberately enabled */}
      {armed ? (
        <Btn variant="hazard" size="sm" onClick={disarm} icon="x">
          DISARM · {secsLeft}s
        </Btn>
      ) : (
        <Btn
          variant="default"
          size="sm"
          disabled={!session || !writeCapable}
          onClick={() => setConfirmOpen(true)}
          icon="bolt"
          title={!session ? 'open a session first' : !writeCapable ? 'active protocol is not write-capable' : 'arm the session for writes'}
        >
          ARM
        </Btn>
      )}

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in">
          <div className="w-[440px] rounded-xl border border-hazard/60 bg-panel shadow-pop p-5">
            <div className="flex items-center gap-2 text-hazard font-semibold mb-2">
              <Icon name="bolt" size={18} strokeWidth={2.25} /> Arm session for writes
            </div>
            <p className="text-xs text-slate-400 mb-3 leading-relaxed">
              Arming flips the whole session to <b className="text-hazard">LIVE-WRITE</b> and re-colors the chrome as a
              standing hazard. It auto-expires after inactivity. Type <Kbd>ARM</Kbd> to confirm — Gate 1 of the
              double-gate.
            </p>
            <Input
              autoFocus
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') doArm();
                if (e.key === 'Escape') setConfirmOpen(false);
              }}
              placeholder="type ARM"
              className="w-full font-mono mb-3"
            />
            <div className="flex justify-end gap-2">
              <Btn variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>Cancel</Btn>
              <Btn variant="hazard" size="sm" onClick={doArm} disabled={confirmText !== 'ARM'} icon="bolt">Arm session</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
