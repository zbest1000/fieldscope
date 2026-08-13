import { create } from 'zustand';
import { io } from 'socket.io-client';
import { api } from './api.js';

// Global app state. One live session at a time in this MVP; artifacts stream in
// over Socket.IO and feed the evidence drawer.
export const useStore = create((set, get) => ({
  drivers: [],
  grouped: {},
  rulepacks: [],
  activeDriverId: null,
  session: null, // { id, driver_id, address, ... }
  armed: false,
  armExpiresAt: null,
  artifacts: [],
  monitor: null, // { monitorId, stats, series }
  toast: null,
  socket: null,

  async init() {
    const [{ drivers, grouped }, { packs }] = await Promise.all([api.drivers(), api.rulepacks()]);
    set({ drivers, grouped, rulepacks: packs, activeDriverId: drivers[0]?.id || null });

    const socket = io('/', { transports: ['websocket', 'polling'] });
    socket.on('artifact', ({ sessionId, artifact }) => {
      if (get().session?.id === sessionId) {
        set((s) => ({ artifacts: [artifact, ...s.artifacts].slice(0, 200) }));
      }
    });
    socket.on('arm', ({ sessionId, armed, reason, expiresInMs }) => {
      if (get().session?.id === sessionId) {
        set({ armed, armExpiresAt: armed ? Date.now() + (expiresInMs || 0) : null });
        if (reason === 'auto-expired') get().flash('ARM auto-expired — back to READ-ONLY');
      }
    });
    socket.on('monitor', (m) => {
      if (get().session?.id === m.sessionId) set({ monitor: m });
    });
    set({ socket });
  },

  flash(msg) {
    set({ toast: { msg, at: Date.now() } });
    setTimeout(() => {
      if (Date.now() - (get().toast?.at || 0) >= 3000) set({ toast: null });
    }, 3200);
  },

  selectDriver(id) {
    set({ activeDriverId: id });
  },

  activeDriver() {
    return get().drivers.find((d) => d.id === get().activeDriverId) || null;
  },

  async openSession({ host, port, unitId }) {
    const driver = get().activeDriver();
    if (!driver) return;
    // close any prior session cleanly
    if (get().session) {
      try {
        await api.closeSession(get().session.id);
      } catch {
        /* ignore */
      }
    }
    const session = await api.openSession({
      driverId: driver.id,
      host,
      port: port ? Number(port) : driver.default_port || undefined,
      unitId: unitId ? Number(unitId) : undefined,
    });
    set({ session, artifacts: [], armed: false, armExpiresAt: null, monitor: null });
    get().flash(`Session open on ${driver.display_name}`);
  },

  async runVerb(verb, params) {
    const s = get().session;
    if (!s) throw new Error('open a session first');
    if (verb === 'diagnose') return api.diagnose(s.id, params);
    return api.runVerb(s.id, verb, params);
  },

  async arm(confirm) {
    const s = get().session;
    const r = await api.arm(s.id, confirm);
    set({ armed: true, armExpiresAt: Date.now() + (r.expiresInMs || 0) });
    get().flash('ARMED — chrome is now a standing hazard indication');
  },
  async disarm() {
    const s = get().session;
    await api.disarm(s.id);
    set({ armed: false, armExpiresAt: null });
  },
}));
