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
| **Session orchestrator** (ARM state machine, rate budget, monitor loops with a stored loss/jitter **summary verdict** on stop — the flaky-link story for every driver) | ✅ `server/src/orchestrator` |
| **Double-gated write path** (ARM + per-write confirm + read-back + mandatory audit, §4.1) | ✅ |
| **Commissioning report export** (self-contained HTML, findings-first, credential redaction, §12.8) | ✅ `server/src/report` |
| **Config backup & drift detection** (capture a device's readable config as a named baseline, diff two baselines or recheck against a live re-capture, export/import baselines as portable JSON, and a live drift watch that re-checks on an interval) | ✅ `server/src/backup` |
| **UI shell** (global chrome, ARM hazard re-color, capability-driven tabs, evidence drawer) | ✅ `client/` |
| **Docker packaging** (multi-stage image, compose stack with simulated plant floor, CI) | ✅ `Dockerfile` |
| **Discovery** | **IP Scanner** (TCP host sweep, port scan, service ID) · **DHCP/BOOTP** (DISCOVER + option decode, rogue-server detection, address assignment in both **DHCP** DORA and classic **BOOTP** modes) · **PROFINET DCP + LLDP** (DCP Identify-All discovery, a **physical port topology** from LLDP — each device's ports and the port-to-port cabling — and **DCP Set** to commission station name / IP / subnet / gateway, ARM-gated) |
| **Drivers** | ICMP · TCP/UDP probe · DNS · **NTP/SNTP** (stratum / leap / offset — unsynchronized & clock-skew verdicts) · TLS/cert · **HTTP/REST** (status-class verdict + JSON-body point tree) · **CoAP** (`/.well-known/core` resource enumeration) · **SNMP** (flaky-cable counters) · **Modbus TCP** (read + gated write with int16/uint32/int32/float32/uint64/int64/float64 + ASCII-string interpretation, every byte/word-order quirk — ABCD/CDAB/BADC/DCBA — and linear scaling to engineering units; 32- & 64-bit setpoints via FC16) · **EtherNet/IP + CIP** (identity/status-word verdicts; CIP Get_Attribute_Single reads) · **S7comm** (rack/slot COTP + SZL identity; ReadVar DB/memory read) · **BACnet/IP** (Who-Is/I-Am + system-status; object-list browse) · **DNP3** (link-status + IIN-flag verdicts; Class 0 binary/analog point decode) · **IEC 60870-5-104** (STARTDT handshake + General Interrogation with COT verdicts; select-before-operate control command) · **MQTT** (topic tree + gated publish) · **Sparkplug B** (birth/death + seq-gap detection; live metric-value read with alias resolution) · **OPC UA** (UACP handshake + error decode; OpenSecureChannel + GetEndpoints endpoint/security-policy enumeration) |

Adding a protocol means dropping one driver file into `server/src/drivers/` — nothing
in the UI, evidence, or rules layers changes. That plugin boundary is the point.

**Per-driver capability reference:** [`docs/DRIVERS.md`](docs/DRIVERS.md) — what each
driver does, its verbs, key exchange, and flagship verdict.

## Install

Three ways to get Fieldscope onto a machine, in order of least setup:

| | What you get | Requirements | Get it |
|---|---|---|---|
| **Portable bundle** | Unpack-and-run — server deps (incl. the native SQLite module) baked in for your OS/arch. No install step, no network. Ideal for an **air-gapped** commissioning laptop. | Node.js ≥ 20 | `fieldscope-<ver>-portable-<os>-<arch>.tar.gz` from [Releases](../../releases) → unpack → `./fieldscope.sh` (or `fieldscope.cmd`) |
| **Install bundle** | Small, platform-neutral source bundle; fetches production deps on first install. | Node.js ≥ 20 + npm, one-time network for `npm ci` | `fieldscope-<ver>.tar.gz` from [Releases](../../releases) → unpack → `./install.sh` → `./fieldscope.sh` |
| **Container** | `ghcr.io/<owner>/fieldscope:<ver>` (and `:latest`). | Docker | `docker run -p 5100:5100 -v fieldscope-data:/data ghcr.io/<owner>/fieldscope:latest` |

Both bundles serve the workbench on `http://localhost:5100`; evidence persists in
`./data` next to the launcher (override with `FIELDSCOPE_DATA`, port with `PORT`).

**Cut a release** by pushing a tag (`git tag v0.1.0 && git push origin v0.1.0`) —
the [release workflow](.github/workflows/release.yml) builds the install bundle,
a portable bundle for Linux/macOS/Windows, and the container image, and attaches
them to a GitHub Release. To build the bundles locally: `npm run package` (writes
`fieldscope-<ver>.tar.gz` and `fieldscope-<ver>-portable-<os>-<arch>.tar.gz` into
`./release/`).

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
| IEC 60870-5-104 | 2404 | station (common address `1`); General Interrogation returns 3 points |
| IEC 60870-5-104 | 2405 | silent link — never confirms STARTDT (exercise the link-not-activated verdict) |
| S7comm | 1102 | S7-300 (`6ES7 315`, rack 0 / slot 2 — refuses the wrong rack/slot) |
| DHCP | 6767/udp | DHCP server offering `10.10.0.50` (point the `dhcp` driver: `server=127.0.0.1`, `server_port=6767`) |
| PROFINET DCP | 34964/udp | DCP responder with `plc-line3` + `io-station-1` (point the `profinet-dcp` driver: `responder_port=34964`) |
| Sparkplug B | (via mqtt 1883) | edge node `Plant1/Line3` birthing + streaming with periodic rebirth |
| OPC UA | 4840 | server completing the UACP Hello/Ack handshake and answering OpenSecureChannel + GetEndpoints (None + Basic256Sha256 endpoints) |
| NTP/SNTP | 1123/udp | stratum-2 synchronized time server (point the `ntp` driver at `127.0.0.1:1123`) |
| HTTP | 8080 | JSON health endpoint; `/secure` → 401, `/boom` → 500, `/elsewhere` → 302 (exercise the status-class verdicts) |
| CoAP | 5683/udp | node serving `/.well-known/core` (temp / humidity / led) + `/sensors/temp` |

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
npm test     # 132 tests: contract, rules, evidence, the double-gate, and every
             # driver end-to-end against its own simulator
```

Each protocol tests against a live local simulator — a Modbus slave, an
EtherNet/IP identity endpoint, an S7 PLC, an MQTT broker (aedes), a Sparkplug B
edge node, an OPC UA server, an SNMP agent, a BACnet/IP controller, a DNP3
outstation, and an IEC 60870-5-104 station — so fault verdicts (gateway-dead,
major-fault, wrong rack/slot, not-authorized, flaky-cable, non-operational, IIN
device-restart / config-corrupt, Sparkplug sequence-gap / node-death, OPC UA
endpoint-URL-invalid, IEC-104 silent-link / wrong-common-address / GI-rejected)
are exercised on real sockets with no hardware or network. The DNP3 CRC is checked against the
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
- **§6.1 / 6.2 / 6.3 / 6.4 protocol catalog** → `drivers/snmp.js` (per-port error counters = the flaky-cable detector), `drivers/ethernet-ip.js` (CIP Identity status word + state verdicts), `drivers/s7comm.js` (ISO-on-TCP/COTP rack-slot check + SZL order number/firmware), `drivers/bacnet.js` (Who-Is/I-Am + device system-status), `drivers/dnp3.js` (link-status addressing check + IIN-flag verdicts, wire-correct CRC), `drivers/iec104.js` (IEC 60870-5-104 APCI STARTDT handshake + General Interrogation, with cause-of-transmission verdicts: link-not-activated, unknown-common-address (COT 46), GI-rejected; plus a single-command (C_SC_NA_1) control write that runs the select-before-operate handshake through the ARM double-gate, and CP56Time2a decoding so time-tagged events — M_SP_TB_1 / M_DP_TB_1 / M_ME_TF_1 — carry real timestamps), `drivers/mqtt.js` (CONNACK verdicts; publish as an ARM-gated write), `drivers/sparkplug.js` (birth/death lifecycle + per-node sequence-gap detection with a dependency-free protobuf codec), `drivers/opcua.js` (OPC UA UACP Hello/Acknowledge handshake + decoded protocol-error StatusCodes; `browse` opens a SecurityPolicy-None secure channel and runs GetEndpoints to enumerate endpoints by security mode / policy / level — a dependency-free binary codec covering NodeIds, ExtensionObjects, LocalizedText and EndpointDescription).
- **§7 Discovery tier** → `drivers/ipscan.js` (TCP host sweep + port scan + service ID, concurrency-pooled and bounded), `drivers/dhcp.js` (DHCP DISCOVER + option decode + rogue-server detection, plus address assignment for a MAC in two modes — **DHCP** DORA DISCOVER→REQUEST→ACK/NAK and classic **BOOTP** single request/reply — as an ARM-gated write), `drivers/profinet-dcp.js` (discovery joining **DCP** Identify-All identity with **LLDP** (IEEE 802.1AB) neighbour detection: the `browse` verb reconstructs the physical port topology — each device's ports and which port cables to which neighbour port — with a logical-subnet fallback when no LLDP is present; plus duplicate-name / unconfigured-IP verdicts and a DCP **Set** write that reconfigures station name / IP / subnet / gateway behind the double-gate with an Identify read-back; the DCP/LLDP codecs run over a UDP test harness — real DCP/LLDP are raw Ethernet, declared `requires_l2`).
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
