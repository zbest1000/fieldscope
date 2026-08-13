import React, { useState } from 'react';
import { useStore } from '../store.js';
import { Btn, Field } from './ui.jsx';
import { GenericVerb, DiagnosePanel, MonitorPanel, WritePanel, RawPanel } from './VerbPanels.jsx';

// One repeated workspace layout for every protocol (§7). Tabs are
// capability-driven: only verbs the driver declares appear, plus a Raw tab.
const GENERIC = ['connect', 'identify', 'browse', 'read'];

export default function Workspace() {
  const driver = useStore((s) => s.activeDriver());
  const { session, openSession, flash } = useStore();
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('');
  const [unitId, setUnitId] = useState('1');
  const [tab, setTab] = useState(null);

  if (!driver) return <div className="p-6 text-slate-500">Select a protocol from the left.</div>;

  const tabs = [...driver.verbs.filter((v) => v !== 'discover' && v !== 'decode'), 'raw'];
  const activeTab = tab && tabs.includes(tab) ? tab : tabs[0];

  async function connect() {
    try {
      await openSession({ host, port, unitId });
    } catch (e) {
      flash(e.message);
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Target bar */}
      <div className="flex items-end gap-3 px-5 py-3 border-b border-edge bg-panel2">
        <div className="text-slate-100 font-semibold self-center mr-2">{driver.display_name}</div>
        <Field label="host">
          <input value={host} onChange={(e) => setHost(e.target.value)} className="bg-ink border border-edge rounded px-2 py-1 text-sm w-40" />
        </Field>
        <Field label="port">
          <input value={port} placeholder={driver.default_port ?? '—'} onChange={(e) => setPort(e.target.value)} className="bg-ink border border-edge rounded px-2 py-1 text-sm w-20" />
        </Field>
        {driver.id === 'modbus-tcp' && (
          <Field label="unit id">
            <input value={unitId} onChange={(e) => setUnitId(e.target.value)} className="bg-ink border border-edge rounded px-2 py-1 text-sm w-16" />
          </Field>
        )}
        <Btn variant="primary" onClick={connect}>{session ? 'Reconnect' : 'Connect'}</Btn>
        {driver.describe && <div className="text-xs text-slate-500 self-center ml-2 max-w-md">{driver.describe}</div>}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-edge bg-panel2 px-3">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm capitalize border-b-2 -mb-px ${
              activeTab === t ? 'border-emerald-500 text-slate-100' : 'border-transparent text-slate-400 hover:text-slate-200'
            } ${t === 'write' ? 'text-hazard/80' : ''} ${t === 'diagnose' ? 'font-semibold' : ''}`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-5">
        {!session && <div className="text-slate-500 text-sm mb-4">No session — set a target and Connect.</div>}
        <TabContent driver={driver} tab={activeTab} />
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
