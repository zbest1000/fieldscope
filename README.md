# Fieldscope

**A read-only, evidence-first diagnostics workbench for OT + IT + IIoT/IoT protocols.**

*by Connected Core Industries — MVP build.*

Fieldscope's thesis is that the tool itself is the deliverable: every action across
every protocol produces a stored, replayable, exportable **artifact** (raw bytes +
timing + decode + verdict), and the tool renders a **verdict** — "here is what is
wrong and why" — rather than a raw dump.

This build implements the architecture's keystone loop end-to-end and the first
tiers of the [roadmap](docs/ARCHITECTURE.md) (§12): the driver
contract + evidence store, the IT tier, and Modbus TCP — everything with proven,
dependency-light implementations that run and are tested here.

## What's built

| Layer | Status |
|---|---|
| **Driver contract** (capability manifest + 9 verbs → uniform `Artifact`) | ✅ `server/src/contract` |
| **Evidence store** (SQLite metadata + blob files, replay, session diff, audit) | ✅ `server/src/evidence` |
| **Diagnostic rules engine** (declarative YAML rulepacks → verdicts, hot-loadable) | ✅ `server/src/rules` |
| **Session orchestrator** (ARM state machine, rate budget, monitor loops) | ✅ `server/src/orchestrator` |
| **Double-gated write path** (ARM + per-write confirm + read-back + mandatory audit, §4.1) | ✅ |
| **UI shell** (global chrome, ARM hazard re-color, capability-driven tabs, evidence drawer) | ✅ `client/` |
| **Drivers** | ICMP · TCP/UDP probe · DNS · TLS/cert · **Modbus TCP** (read + gated write) |

Adding a protocol means dropping one driver file into `server/src/drivers/` — nothing
in the UI, evidence, or rules layers changes. That plugin boundary is the point.

## Quick start

Requires Node.js ≥ 20.

```bash
cd fieldscope
npm run install:all

# terminal 1 — backend (REST + Socket.IO) on :5100
npm run dev:server

# terminal 2 — client (Vite) on :3100, proxying /api to the backend
npm run dev:client
```

Open http://localhost:3100.

To run everything from the backend alone (it serves the built client):

```bash
npm start          # builds the client, then serves it + API on :5100
```

### Try it without hardware

A Modbus TCP simulator ships for tests:

```bash
node -e 'import("./server/test/modbus-sim.js").then(m=>m.startModbusSim({port:5020}).then(()=>console.log("sim on 5020")))'
```

Then in the UI: pick **Modbus TCP**, set host `127.0.0.1` port `5020`, **Connect**, and
run **Diagnose** (→ "Modbus responding normally"), **Read**, or the **Write** tab
(ARM in the top bar first).

## Tests

```bash
npm test     # 17 tests: contract, rules, evidence, modbus e2e, the double-gate, IT tier
```

They run against a local Modbus simulator — no real device or network needed.

## Architecture mapping

The full design spec is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Section pointers:

- **§3 System architecture** → `server/index.js` wires registry → orchestrator → rules → store.
- **§4 Driver contract** → `contract/contract.js` (manifest normalize, `makeArtifact`, verbs).
- **§4.1 Write double-gate** → `orchestrator/orchestrator.js` (`arm` / `prepareWrite` / `confirmWrite`) + `client/.../TopBar.jsx`, `WritePanel`.
- **§5 Diagnose rules** → `rules/engine.js` + `server/rulepacks/*.yaml`.
- **§7 UI structure** → `client/src/components/*` (one repeated workspace, capability-driven tabs, Diagnose/Monitor/Raw).
- **§9 Evidence data model** → `evidence/store.js` (Target / Session / Artifact / Verdict / Audit; replay + diff).

## Deliberately out of scope for this MVP

Faithful to the spec's own "observe vs participate" honesty (§11): real-time bus
participation (EtherCAT/SERCOS/PROFIBUS), radio tiers (need dongles), L2 capture
(needs a mirror port + admin/pcap), and safety protocols (decode-only by design,
§6.7) are **not** implemented here. The contract already models them
(`requires_l2`, `requires_hardware`, `safety_locked`) so they slot in without
touching the core.
