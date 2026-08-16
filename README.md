# Fieldscope

**A read-only, evidence-first diagnostics workbench for OT + IT + IIoT/IoT protocols.**

*by Connected Core Industries — MVP build.*

Fieldscope's thesis is that the tool itself is the deliverable: every action across
every protocol produces a stored, replayable, exportable **artifact** (raw bytes +
timing + decode + verdict), and the tool renders a **verdict** — "here is what is
wrong and why" — rather than a raw dump.

This build implements the architecture's keystone loop end-to-end and the whole
of the [roadmap](docs/ARCHITECTURE.md)'s (§12) "shippable core" (§11): the
driver contract + evidence store, the IT tier (including SNMP), and every
proven-library protocol the spec names as the ~80%-of-value set — Modbus,
EtherNet/IP, S7comm, BACnet/IP, DNP3, MQTT, Sparkplug B, and OPC UA — plus
commissioning-report export, Docker packaging, and CI. Everything here is a
proven, dependency-light implementation that runs and is tested against a live
simulator. Deliberately out of scope remain the spec's long tail: wireless
tiers (hardware-gated), real-time buses (observe-only), and L2/pcap capture.

## What's built

| Layer | Status |
|---|---|
| **Driver contract** (capability manifest + 9 verbs → uniform `Artifact`) | ✅ `server/src/contract` |
| **Evidence store** (SQLite metadata + blob files, replay, session diff, audit) | ✅ `server/src/evidence` |
| **Diagnostic rules engine** (declarative YAML rulepacks → verdicts, hot-loadable) | ✅ `server/src/rules` |
| **Session orchestrator** (ARM state machine, rate budget, monitor loops) | ✅ `server/src/orchestrator` |
| **Double-gated write path** (ARM + per-write confirm + read-back + mandatory audit, §4.1) | ✅ |
| **Commissioning report export** (self-contained HTML, findings-first, credential redaction, §12.8) | ✅ `server/src/report` |
| **UI shell** (global chrome, ARM hazard re-color, capability-driven tabs, evidence drawer) | ✅ `client/` |
| **Docker packaging** (multi-stage image, compose stack with simulated plant floor, CI) | ✅ `Dockerfile` |
| **Discovery** | **IP Scanner** (nmap-style host sweep, port scan, service ID) · **DHCP/BOOTP** (DISCOVER + option decode, rogue-server detection) · **PROFINET DCP** (PRONETA-style Identify-All device discovery) |
| **Drivers** | ICMP · TCP/UDP probe · DNS · TLS/cert · **SNMP** (flaky-cable counters) · **Modbus TCP** (read + gated write) · **EtherNet/IP + CIP** (identity/status-word verdicts) · **S7comm** (rack/slot COTP + SZL identity) · **BACnet/IP** (Who-Is/I-Am + system-status) · **DNP3** (link-status + IIN-flag verdicts) · **MQTT** (topic tree + gated publish) · **Sparkplug B** (birth/death + seq-gap detection) · **OPC UA** (UACP handshake + error decode) |

Adding a protocol means dropping one driver file into `server/src/drivers/` — nothing
in the UI, evidence, or rules layers changes. That plugin boundary is the point.

## Quick start (Docker)

```bash
docker compose up --build            # workbench on http://localhost:5100
```

To also get a simulated plant floor to point it at (no hardware needed):

```bash
docker compose --profile lab up --build
```

The `simlab` container serves, at hostname `simlab` from inside the stack:

| Simulator | Port | Behavior |
|---|---|---|
| Modbus TCP | 5020 | healthy slave (holding regs `1000+n`) |
| Modbus TCP | 5021 | gateway whose RTU is dead — every request → exception 0x0B |
| EtherNet/IP | 44818 | operational PLC (Identity object, owned + configured) |
| EtherNet/IP | 44819 | drive reporting a Major Unrecoverable Fault |
| MQTT | 1883 | open broker |
| MQTT | 1884 | auth-required broker (`ops`/`secret` — exercise the CONNACK verdicts) |
| SNMP | 1161/udp | managed switch, community `public`, error counters climbing on `eth1` |
| BACnet/IP | 47808/udp | operational controller (device `260001`, Automated Logic) |
| BACnet/IP | 47809/udp | controller reporting system-status non-operational (device `260002`) |
| DNP3 | 20000 | outstation `1024`, IIN clean |
| DNP3 | 20001 | outstation `1025` with the device-restart IIN bit set |
| S7comm | 1102 | S7-300 (`6ES7 315`, rack 0 / slot 2 — refuses the wrong rack/slot) |
| DHCP | 6767/udp | DHCP server offering `10.10.0.50` (point the `dhcp` driver: `server=127.0.0.1`, `server_port=6767`) |
| PROFINET DCP | 34964/udp | DCP responder with `plc-line3` + `io-station-1` (point the `profinet-dcp` driver: `responder_port=34964`) |
| Sparkplug B | (via mqtt 1883) | edge node `Plant1/Line3` birthing + streaming with periodic rebirth |
| OPC UA | 4840 | server completing the UACP Hello/Acknowledge handshake |

Evidence persists in the `fieldscope-data` volume across restarts. The image
runs unprivileged; TCP/UDP drivers are fully functional in-container, while raw
ICMP needs `--cap-add NET_RAW` and L2/pcap tiers are out of container scope by
design (§10).

## Quick start (from source)

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
npm test     # 68 tests: contract, rules, evidence, the double-gate, and every
             # driver end-to-end against its own simulator
```

Each protocol tests against a live local simulator — a Modbus slave, an
EtherNet/IP identity endpoint, an S7 PLC, an MQTT broker (aedes), a Sparkplug B
edge node, an OPC UA server, an SNMP agent, a BACnet/IP controller, and a DNP3
outstation — so fault verdicts (gateway-dead, major-fault, wrong rack/slot,
not-authorized, flaky-cable, non-operational, IIN device-restart / config-corrupt,
Sparkplug sequence-gap / node-death, OPC UA endpoint-URL-invalid) are exercised
on real sockets with no hardware or network. The DNP3 CRC is checked against the
opendnp3 reference, and the Sparkplug protobuf codec round-trips through the
driver's own decoder. The same simulators
power the compose `lab` profile via `server/test/sim-lab.js`. CI runs the
suite, builds the client, builds the Docker image, and smoke-tests the
container on every push.

## Architecture mapping

The full design spec is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Section pointers:

- **§3 System architecture** → `server/index.js` wires registry → orchestrator → rules → store.
- **§4 Driver contract** → `contract/contract.js` (manifest normalize, `makeArtifact`, verbs).
- **§4.1 Write double-gate** → `orchestrator/orchestrator.js` (`arm` / `prepareWrite` / `confirmWrite`) + `client/.../TopBar.jsx`, `WritePanel`.
- **§5 Diagnose rules** → `rules/engine.js` + `server/rulepacks/*.yaml`.
- **§6.1 / 6.2 / 6.3 / 6.4 protocol catalog** → `drivers/snmp.js` (per-port error counters = the flaky-cable detector), `drivers/ethernet-ip.js` (CIP Identity status word + state verdicts), `drivers/s7comm.js` (ISO-on-TCP/COTP rack-slot check + SZL order number/firmware), `drivers/bacnet.js` (Who-Is/I-Am + device system-status), `drivers/dnp3.js` (link-status addressing check + IIN-flag verdicts, wire-correct CRC), `drivers/mqtt.js` (CONNACK verdicts; publish as an ARM-gated write), `drivers/sparkplug.js` (birth/death lifecycle + per-node sequence-gap detection with a dependency-free protobuf codec), `drivers/opcua.js` (OPC UA UACP Hello/Acknowledge handshake + decoded protocol-error StatusCodes).
- **§7 Discovery tier** → `drivers/ipscan.js` (nmap-style host sweep + port scan + service ID, concurrency-pooled and bounded), `drivers/dhcp.js` (DHCP DISCOVER + BOOTP/option decode + rogue-server detection), `drivers/profinet-dcp.js` (PRONETA-style DCP Identify-All device discovery with duplicate-name / unconfigured-IP commissioning verdicts; the DCP codec runs over a UDP test harness — real DCP is raw Ethernet, declared `requires_l2`).
- **§7 UI structure** → `client/src/components/*` (one repeated workspace, capability-driven tabs, Diagnose/Monitor/Raw).
- **§7 Evidence & reporting / §12.8** → `report/report.js` (findings-first HTML commissioning report with credential redaction, exported per session from the Evidence view).
- **§9 Evidence data model** → `evidence/store.js` (Target / Session / Artifact / Verdict / Audit; replay + diff).

## Deliberately out of scope for this MVP

Faithful to the spec's own "observe vs participate" honesty (§11): real-time bus
participation (EtherCAT/SERCOS/PROFIBUS), radio tiers (need dongles), L2 capture
(needs a mirror port + admin/pcap), and safety protocols (decode-only by design,
§6.7) are **not** implemented here. The contract already models them
(`requires_l2`, `requires_hardware`, `safety_locked`) so they slot in without
touching the core.
