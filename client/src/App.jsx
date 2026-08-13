import React, { useEffect, useState } from 'react';
import { useStore } from './store.js';
import TopBar from './components/TopBar.jsx';
import LeftRail from './components/LeftRail.jsx';
import Workspace from './components/Workspace.jsx';
import EvidenceDrawer from './components/EvidenceDrawer.jsx';
import Home from './components/Home.jsx';
import Evidence from './components/Evidence.jsx';

export default function App() {
  const { init, toast } = useStore();
  const [view, setView] = useState('home'); // home | workspace | evidence
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    init().then(() => setReady(true)).catch((e) => setErr(e.message));
  }, []);

  if (err) return <Center>Backend unreachable: {err}</Center>;
  if (!ready) return <Center>Loading Fieldscope…</Center>;

  return (
    <div className="h-full flex flex-col">
      <TopBar />
      <div className="flex-1 flex min-h-0">
        <LeftRail view={view} setView={setView} />
        <div className="flex-1 flex flex-col min-w-0">
          {view === 'home' && <Home setView={setView} />}
          {view === 'workspace' && <Workspace />}
          {view === 'evidence' && <Evidence />}
          {view !== 'evidence' && <EvidenceDrawer />}
        </div>
      </div>
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 px-4 py-2 rounded bg-panel border border-edge text-sm text-slate-200 shadow-lg">
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function Center({ children }) {
  return <div className="h-full flex items-center justify-center text-slate-400">{children}</div>;
}
