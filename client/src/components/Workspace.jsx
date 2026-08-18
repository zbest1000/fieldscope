import React, { useState } from 'react';
import { useStore } from '../store.js';
import { Btn, Field, Input, Icon, Badge, EmptyState } from './ui.jsx';
import { GenericVerb, DiagnosePanel, MonitorPanel, WritePanel, RawPanel } from './VerbPanels.jsx';

// One repeated workspace layout for every protocol (§7). Tabs are
// capability-driven: only verbs the driver declares appear, plus a Raw tab.
const GENERIC = ['connect', 'identify', 'browse', 'read'];
const VERB_ICON = { connect: 'plug', identify: 'info', browse: 'layers', read: 'file', monitor: 'activity', write: 'bolt', diagnose: 'shield', raw: 'copy' };

export default function Workspace() {
  const driver = useStore((s) => s.activeDriver());
  const { session, openSession, disconnect, flash } = useStore();
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('');
  const [unitId, setUnitId] = useState('1');
  const [tab, setTab] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!driver) return <EmptyState title="Select a protocol" icon="layers">Pick one from the left rail to open its workspace.</EmptyState>;

  // Is the live session for *this* driver?
  const connected = session && session.driver_id === driver.id;
  const tabs = [...driver.verbs.filter((v) => v !== 'discover' && v !== 'decode'), 'raw'];
  const activeTab = tab && tabs.includes(tab) ? tab : tabs[0];

  async function connect() {
    setBusy(true);
    try {
      await openSession({ host, port, unitId });
    } catch (e) {
      flash(e.message);
    } finally {
      setBusy(false);
    }
  }
  const onEnter = (e) => e.key === 'Enter' && connect();

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Target bar */}
      <div className="flex items-end gap-3 px-5 py-3 border-b border-edge glass">
        <div className="self-center mr-1">
          <div className="text-slate-100 font-semibold leading-tight">{driver.display_name}</div>
          <div className="flex items-center gap-1.5 text-[11px] mt-0.5">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-slate-600'}`} />
            <span className={connected ? 'text-emerald-400' : 'text-slate-500'}>{connected ? 'connected' : 'not connected'}</span>
          </div>
        </div>
        <Field label="host">
          <Input value={host} onChange={(e) => setHost(e.target.value)} onKeyDown={onEnter} className="w-40" />
        </Field>
        <Field label="port">
          <Input value={port} placeholder={String(driver.default_port ?? '—')} onChange={(e) => setPort(e.target.value)} onKeyDown={onEnter} className="w-24" />
        </Field>
        {driver.id === 'modbus-tcp' && (
          <Field label="unit id">
            <Input value={unitId} onChange={(e) => setUnitId(e.target.value)} onKeyDown={onEnter} className="w-16" />
          </Field>
        )}
        <Btn variant="primary" onClick={connect} busy={busy} icon="plug">{connected ? 'Reconnect' : 'Connect'}</Btn>
        {connected && <Btn variant="ghost" size="sm" onClick={disconnect} icon="x">Close</Btn>}
        {driver.describe && <div className="text-xs text-slate-500 self-center ml-auto max-w-md text-right hidden xl:block">{driver.describe}</div>}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-edge bg-panel2/40 px-3">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`relative flex items-center gap-1.5 mt-1 px-3.5 py-2 rounded-t-md text-sm capitalize transition-colors ${
              activeTab === t
                ? 'text-slate-100 bg-gradient-to-b from-white/[0.05] to-transparent'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.02]'
            } ${t === 'write' ? (activeTab === t ? 'text-hazard' : 'text-hazard/80') : ''}`}
          >
            <Icon name={VERB_ICON[t] || 'dot'} size={14} />
            {t}
            {t === 'diagnose' && <span className="h-1 w-1 rounded-full bg-emerald-500" />}
            {activeTab === t && (
              <span className={`absolute left-2 right-2 -bottom-px h-0.5 rounded-full ${t === 'write' ? 'bg-hazard' : 'bg-emerald-500'} shadow-[0_0_8px_rgba(16,185,129,0.6)]`} />
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-5">
        {!connected ? (
          <EmptyState title="No session yet" icon={VERB_ICON[activeTab] || 'plug'}>
            Set a target host/port above and press <b className="text-slate-300">Connect</b> to open a session on{' '}
            {driver.display_name}.
          </EmptyState>
        ) : (
          <TabContent driver={driver} tab={activeTab} />
        )}
      </div>
    </div>
  );
}

function TabContent({ driver, tab }) {
  if (tab === 'raw') return <RawPanel />;
  if (tab === 'diagnose') return <DiagnosePanel />;
  if (tab === 'monitor') return <MonitorPanel driver={driver} />;
  if (tab === 'write') return <WritePanel driver={driver} />;
  if (GENERIC.includes(tab)) return <GenericVerb driver={driver} verb={tab} />;
  return <div className="text-slate-500">Unsupported tab.</div>;
}
