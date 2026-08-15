import React, { useEffect, useState } from 'react';
import { useStore } from './store.js';
import TopBar from './components/TopBar.jsx';
import LeftRail from './components/LeftRail.jsx';
import Workspace from './components/Workspace.jsx';
import EvidenceDrawer from './components/EvidenceDrawer.jsx';
import Home from './components/Home.jsx';
import Evidence from './components/Evidence.jsx';
import { Icon, Spinner } from './components/ui.jsx';

export default function App() {
  const { init, toast } = useStore();
  const [view, setView] = useState('home'); // home | workspace | evidence
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    init().then(() => setReady(true)).catch((e) => setErr(e.message));
  }, []);

  if (err)
    return (
      <Center>
        <div className="flex flex-col items-center gap-2 text-rose-400">
          <Icon name="error" size={28} />
          <div className="font-medium">Backend unreachable</div>
          <div className="text-xs text-slate-500">{err}</div>
        </div>
      </Center>
    );
  if (!ready)
    return (
      <Center>
        <div className="flex flex-col items-center gap-3 text-slate-400">
          <span className="text-emerald-400"><Spinner size={26} /></span>
          <div className="text-sm">Loading Fieldscope…</div>
        </div>
      </Center>
    );

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
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-2 px-4 py-2.5 rounded-lg bg-panel border border-edge2 text-sm text-slate-200 shadow-pop animate-fade-in">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function Center({ children }) {
  return <div className="h-full flex items-center justify-center">{children}</div>;
}
