import React, { useEffect, useState } from 'react';
import { useStore } from '../store.js';

// Global chrome (§7): SOURCE adapter, state pill LIVE/READ-ONLY, ARM toggle.
// Arming re-colors the whole shell as a standing hazard indication and shows
// the auto-expiry countdown (§4.1).
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
      className={`flex items-center gap-4 px-4 h-12 border-b border-edge bg-panel2 text-sm shrink-0 ${
        armed ? 'armed-chrome bg-[#2a1f08]' : ''
      }`}
    >
      <div className="font-semibold tracking-wide text-slate-100">
        FIELDSCOPE<span className="text-slate-500 ml-2 font-normal text-xs">Connected Core Industries</span>
      </div>

      <div className="flex items-center gap-2 text-xs text-slate-400">
        <span className="text-slate-500">SOURCE</span>
        <span className="px-2 py-0.5 rounded bg-panel border border-edge">default NIC</span>
      </div>

      <div className="flex-1" />

      {session && (
        <div className="text-xs text-slate-400">
          <span className="text-slate-500">session</span>{' '}
          <span className="font-mono text-slate-300">{session.address || session.driver_id}</span>
        </div>
      )}

      {/* LIVE / READ-ONLY state pill */}
      <span
        className={`px-3 py-1 rounded-full text-xs font-semibold border ${
          armed
            ? 'bg-hazard text-black border-hazard'
            : 'bg-panel text-emerald-400 border-emerald-800'
        }`}
      >
        {armed ? '● LIVE-WRITE' : '● READ-ONLY'}
      </span>

      {/* ARM toggle — dark until deliberately enabled */}
      {armed ? (
        <button
          onClick={disarm}
          className="px-3 py-1 rounded text-xs font-semibold bg-hazard text-black hover:brightness-110"
        >
          DISARM ({secsLeft}s)
        </button>
      ) : (
        <button
          disabled={!session || !writeCapable}
          onClick={() => setConfirmOpen(true)}
          title={!writeCapable ? 'active protocol is not write-capable' : 'arm the session for writes'}
          className="px-3 py-1 rounded text-xs font-semibold border border-edge text-slate-400 hover:text-hazard hover:border-hazard disabled:opacity-30 disabled:hover:text-slate-400 disabled:hover:border-edge"
        >
          ARM
        </button>
      )}

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-[420px] rounded-lg border border-hazard bg-panel p-5">
            <div className="text-hazard font-semibold mb-1">Arm session for writes</div>
            <p className="text-xs text-slate-400 mb-3">
              Arming flips the whole session to LIVE-WRITE and re-colors the chrome as a standing
              hazard. It auto-expires after inactivity. Type <span className="font-mono text-hazard">ARM</span> to
              confirm (Gate 1 of the double-gate).
            </p>
            <input
              autoFocus
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doArm()}
              placeholder="type ARM"
              className="w-full bg-ink border border-edge rounded px-3 py-2 font-mono text-sm mb-3"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmOpen(false)}
                className="px-3 py-1.5 rounded text-xs border border-edge text-slate-400"
              >
                Cancel
              </button>
              <button
                onClick={doArm}
                disabled={confirmText !== 'ARM'}
                className="px-3 py-1.5 rounded text-xs font-semibold bg-hazard text-black disabled:opacity-40"
              >
                Arm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
