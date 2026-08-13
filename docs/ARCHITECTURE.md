# Fieldscope — Design & Architecture

**A read-only, evidence-first diagnostics workbench for OT + IT + IIoT/IoT protocols.**

*Working title: Fieldscope (by Connected Core Industries). Status: design specification, pre-implementation.*

---

## Table of contents

1. [Positioning & product thesis](#1-positioning--product-thesis)
2. [Design principles](#2-design-principles)
3. [System architecture](#3-system-architecture)
4. [The driver contract](#4-the-driver-contract)
5. [Diagnose rule format](#5-diagnose-rule-format)
6. [Protocol catalog (with library + effort ratings)](#6-protocol-catalog)
7. [UI structure](#7-ui-structure)
8. [Cross-cutting subsystems](#8-cross-cutting-subsystems)
9. [Evidence & data model](#9-evidence--data-model)
10. [Technology stack](#10-technology-stack)
11. [Buildability summary](#11-buildability-summary)
12. [Build sequencing / roadmap](#12-build-sequencing--roadmap)

---

## 1. Positioning & product thesis

Most diagnostic work on a plant floor happens with a scattered kit — Wireshark, nmap, a vendor's proprietary config tool, a Modbus poller, an OPC UA client, PuTTY on a serial cable. Each answers one question and forgets it. **Fieldscope's thesis is that the tool itself should be the deliverable:** a single workbench where every action across every protocol produces a stored, replayable, exportable piece of evidence, and where the tool renders a *verdict* rather than a raw dump.

**Two differentiators define the product:**

1. **Evidence-first.** Every probe, poll, capture, and browse is captured as an artifact (raw bytes + timing + decode + verdict) into a local session store. Sessions replay and diff. This is the moat — it turns ad-hoc troubleshooting into a commissioning/forensic record.
2. **One workbench, OT and IT.** The same UI, logging, and evidence layer serves an ICMP ping, a CIP Forward Open, a GOOSE stream, and a Sparkplug birth sequence. Engineers stop context-switching between six tools.

**Non-goals:** Fieldscope is not a historian, not a SCADA, not an installer/wiring tool, and not a real-time bus master (see §11). It observes and interrogates; it does not run the process.

---

## 2. Design principles

| Principle | Rationale | Implementation consequence |
|---|---|---|
| **Read-only by default, writes double-gated** | Engineers won't run an unknown tool that can write silently — but commissioning still needs writes. | Every write clears two gates (ARM session toggle + per-write confirm) with mandatory audit (§4.1). Safety protocols are the one deliberate exclusion: decode-only, no write path in code (§6.7). |
| **Evidence, not output** | Troubleshooting value is in the record, not the moment. | Every verb returns an artifact to the evidence store. Sessions are replayable and diffable. |
| **Bounded by design** | An unbounded scan on a PROFINET segment can disrupt production. | Scans are CIDR-capped and rate-limited. Probe cadence is configurable and conservative by default. |
| **Offline-first** | Plant floors are air-gapped; no license phone-home tolerated. | No cloud dependency. Local SQLite + file store. Optional signed offline license. |
| **Uniform driver contract** | ~60 protocols cannot each get bespoke UI. | One interface; UI/logging/evidence written once. Capability manifest drives what renders. |
| **Verify the tool** | Engineers must be able to confirm the tool isn't lying. | Every workspace exposes a **Raw** tab showing the actual bytes on the wire. |

---

## 3. System architecture

```
┌───────────────────────────────────────────────────────────┐
│  UI Shell                                                 │
│  · workspaces · evidence drawer · global state pills      │
├───────────────────────────────────────────────────────────┤
│  Session Orchestrator                                     │
│  · job queue · cancellation tokens · rate limiting        │
│  · target profiles · credential vault · ARM state         │
├───────────────────────────────────────────────────────────┤
│  Diagnostic Rules Engine                                  │
│  · correlates driver results → plain-English verdicts     │
│  · declarative YAML rulepacks (hot-loadable)              │
├───────────────────────────────────────────────────────────┤
│  Protocol Driver Layer            ← PLUGIN BOUNDARY        │
│  ┌─────────┬────────────┬───────────┬──────────────────┐  │
│  │   IT    │ Industrial │  Utility  │  IIoT / IoT / RF  │  │
│  └─────────┴────────────┴───────────┴──────────────────┘  │
│  each driver implements the capability manifest (§4)      │
├───────────────────────────────────────────────────────────┤
│  Transport Abstraction                                    │
│  · TCP/UDP · raw sockets · pcap (Npcap/libpcap)           │
│  · serial (RS-232/485) · TLS · L2 raw Ethernet            │
│  · radio adapters (Zigbee/BLE/Z-Wave/LoRa dongles)        │
├───────────────────────────────────────────────────────────┤
│  Device Catalog                                           │
│  · EDS · GSD/GSDML · CSP+ · SunSpec models · BACnet EPICS │
├───────────────────────────────────────────────────────────┤
│  Evidence Store                                           │
│  · SQLite (metadata/results) + pcap/blob files (raw)      │
│  · single PTP/NTP-anchored timeline                       │
└───────────────────────────────────────────────────────────┘
```

**Data flow of a single action:** UI issues intent → Orchestrator checks ARM state + rate budget → dispatches to driver via manifest verb → driver uses Transport + Device Catalog → returns a structured result + raw bytes → Rules Engine annotates with a verdict → Evidence Store persists artifact against the session timeline → UI renders result + verdict + raw.

The **plugin boundary** is the architectural keystone: adding a protocol never touches UI, logging, or evidence code. A driver is a signed assembly declaring a manifest + implementing verbs.

---

## 4. The driver contract

Every protocol plugin declares a **capability manifest** and implements whichever verbs apply. Unimplemented verbs grey out in the UI automatically.

### Capability manifest (declarative)

```yaml
driver:
  id: ethernet-ip
  display_name: EtherNet/IP + CIP
  domain: industrial            # it | industrial | utility | iiot | iot-rf
  transport: [tcp, udp]         # udp for Class 1 I/O (multicast)
  default_port: 44818
  requires_l2: false            # true = needs raw Ethernet / mirror port
  requires_admin: false         # true = needs root/Administrator + pcap
  requires_hardware: null       # e.g. "zigbee-coordinator" for RF drivers
  catalog_formats: [eds]        # device-description files it can ingest
  write_capable: true           # gated behind global ARM
  safety_locked: false          # true = decode-only, no write path ever

  verbs:                        # which contract methods this driver provides
    - discover
    - connect
    - identify
    - browse
    - read
    - write
    - monitor
    - decode
    - diagnose
```

### Verb interface (conceptual signatures)

| Verb | Input | Output | Notes |
|---|---|---|---|
| `Discover(scope, budget)` | CIDR / broadcast domain, rate budget | `DeviceRef[]` | Bounded. Emits per-device evidence. |
| `Connect(target, opts)` | endpoint, timeout, creds | `Session` + handshake detail | Reports negotiated params (PDU size, RPI, cipher…). |
| `Identify(session)` | live session | vendor/model/fw/serial/status | Decodes status/fault words. |
| `Browse(session)` | live session | `PointTree` (tags/objects/nodes/registers) | Uses Device Catalog to name + type points. |
| `Read(session, points)` | point refs | typed values + raw | — |
| `Write(session, points, values)` | point refs + values | ack + raw | **ARM-gated.** Audit entry mandatory. |
| `Monitor(session, points, cadence)` | subscription/poll spec | stream + stats (jitter, min/avg/max RTT, retries) | Rolling sparkline data. |
| `Decode(frame)` | captured bytes | structured decode | Passive; used in capture mode. May delegate to `tshark`. |
| `Diagnose(session)` | live session / results | `Verdict[]` | Runs the driver's rulepack (§5). The differentiator. |

**Every verb returns an `Artifact`:** `{ raw_bytes, timestamp (PTP-anchored), decode, verdict?, session_id }`. That uniformity is what lets the evidence store, replay, diff, and export be written once for all ~60 protocols.

### 4.1 Write capability & the double-gate

Fieldscope is read-only by *default*, not read-only by *limitation*. Commissioning genuinely requires writes — a Modbus setpoint, a forced coil to prove an output, a CIP config attribute, an OPC UA tag, a BACnet priority-array command. Writes are first-class, but every write clears **two independent gates** and leaves a record that cannot be turned off.

**Gate 1 — ARM (session-level).** The global state pill flips `READ-ONLY → LIVE-WRITE` only by deliberate action (typed confirmation, not a stray click). Arming re-colors the entire chrome as a standing hazard indication and **auto-expires** after an inactivity timeout, so the tool never sits silently writable. Default is off, every session.

**Gate 2 — Per-write confirm.** Even when armed, each individual write shows a confirmation: target, point, **current value → proposed value**, data type, and the decoded engineering meaning if the catalog knows it. Nothing fires silently; batch writes list every point before commit.

Supporting mechanisms (part of the write path; the audited ones are non-disableable):

| Mechanism | Purpose |
|---|---|
| **Dry-run / preview** | Compose the write and see the exact bytes + decode *without sending*. Validate framing before it's live. |
| **Value validation** | Range/type check against the device catalog (EDS / GSDML / SunSpec define valid ranges). Warn on out-of-range or type mismatch before send. |
| **Write allow-list** (per target) | A commissioning profile can mark only specific points writable — everything else stays read-only even when armed. Kills fat-finger writes to the wrong address. |
| **Read-back verification** | After a write, auto-read the value back and report whether it actually took. |
| **Hold watchdog** | Timed reversion for hold-type writes (forcing an output on for a test) so a held value can't be left latched. |
| **Mandatory audit** *(non-disableable)* | Every write is an artifact: operator, timestamp, before/after value, and the confirmation record. This — not a click-through clause — is what provides real accountability. |

**Write verbs by domain:** Modbus FC05/06/15/16 · CIP Set Attribute Single/All · S7 write DB/M/Q/flag · OPC UA Write · BACnet WriteProperty *(at a priority level; release = write NULL at that priority)* · DNP3 CROB / analog output · MQTT publish / Sparkplug NCMD-DCMD.

**Safety protocols are the one deliberate exclusion — and it is not a "gate it harder" case.** See §6.7.

---

## 5. Diagnose rule format

Verdicts are the product's soul: not "here is data" but "here is what is wrong and why." Rules are declarative YAML so field-discovered failure signatures can be added **without recompiling**.

```yaml
rulepack: modbus-tcp
rules:
  - id: gateway-answers-slave-dead
    when:
      transport.tcp_connect: success
      response.exception_code: 0x0B          # gateway target failed to respond
    verdict:
      severity: error
      title: "Gateway reachable, downstream slave not responding"
      detail: >
        TCP/502 accepts and a device is answering, but every request returns
        exception 0x0B (Gateway Target Device Failed To Respond). A Modbus
        gateway is replying; the addressed RTU slave behind it is offline,
        mis-wired, or set to the wrong unit ID.
      next_steps:
        - "Verify unit/slave ID matches the RTU's configured address"
        - "Check RS-485 A/B polarity and termination on the downstream segment"

  - id: silent-timeout
    when:
      transport.tcp_connect: success
      response: none
      timeout: true
    verdict:
      severity: warn
      title: "Port open but no Modbus response"
      detail: >
        TCP handshake completes but no MBAP response arrives. Often a firewall
        that accepts SYN but drops the payload, or a device that is listening
        but its Modbus stack is hung.

  - id: healthy
    when:
      response.function_code_echoed: true
      response.exception_code: none
    verdict:
      severity: ok
      title: "Modbus responding normally"
```

**Rule engine mechanics:** each `Diagnose()` run feeds the driver's result set + transport facts into the matching rulepack; rules evaluate top-to-bottom; matched verdicts attach to the session with severity (`ok` / `info` / `warn` / `error`) and optional `next_steps`. Rulepacks ship with the driver but live as editable files — a customer-specific signature can be dropped in on site.

---

## 6. Protocol catalog

Ratings key:
- **Lib** — maturity of an available open library you'd build on. 🟢 mature / 🟡 partial or fiddly / 🔴 none, roll your own or `tshark`-decode only.
- **Effort** — solo-dev effort to a useful feature set. ● low / ●● medium / ●●● high.
- **Mode** — **Full** (interact + decode) / **Observe** (passive decode only — physically can't safely participate) / **HW** (needs specific radio/interface hardware).

### 6.1 IT / network tier

*Solves the majority of "the PLC is offline" calls. Mostly proven by nmap + Wireshark.*

| Protocol / tool | Lib | Effort | Mode | Diagnostic focus |
|---|---|---|---|---|
| ICMP echo/timestamp | 🟢 | ● | Full | Reachability, RTT baseline |
| TCP/UDP connect probes | 🟢 | ● | Full | Port state, SYN-accept-but-drop detection |
| Traceroute (ICMP + TCP) | 🟢 | ● | Full | Path, firewalled-hop bypass |
| ARP table + gratuitous-ARP | 🟢 | ● | Full | **IP-conflict detection** (top commissioning fault) |
| DNS (A/PTR/SRV) | 🟢 | ● | Full | Name resolution, reverse lookups |
| DHCP discover + option decode | 🟢 | ●● | Full | Rogue-server detection, option inspection |
| LLDP / CDP / FDP | 🟢 | ●● | Observe | Port-to-port topology, VLAN/PoE TLVs |
| mDNS/DNS-SD, SSDP/UPnP, WS-Discovery | 🟢 | ●● | Full | Modern camera/drive/HMI announcement |
| NetBIOS / SMB enumeration | 🟢 | ●● | Full | Legacy HMI/SCADA shares |
| STP/RSTP/MSTP BPDU decode | 🟡 | ●● | Observe | Root bridge, port roles, topology-change floods |
| **IGMP / multicast membership** | 🟡 | ●●● | Observe | **Critical** — CIP I/O, PROFINET, GOOSE, UA PubSub starvation |
| VRRP / HSRP | 🟡 | ●● | Observe | Gateway redundancy state |
| Path MTU / jumbo-frame validation | 🟢 | ●● | Full | Silent MTU black-hole detection |
| Throughput probe (iperf-style) | 🟢 | ●● | Full | Link capacity, one-way jitter histogram |
| SNMP v1/v2c/v3 + MIB browser | 🟢 | ●● | Full | **Per-port error/discard/CRC counters** (flaky cable) |
| NTP + PTP (IEEE 1588) | 🟢 | ●●● | Observe | Offset, stratum, grandmaster ID, path delay* |
| TLS / cert inspector | 🟢 | ● | Full | Chain, expiry, cipher, policy audit |
| Syslog receiver | 🟢 | ● | Full | Device event ingestion |
| NETCONF / RESTCONF / gNMI | 🟢 | ●● | Full | Modern switch config + streaming telemetry |
| 802.1X / RADIUS / TACACS+ reach | 🟡 | ●● | Full | Port-security lockout diagnosis |
| FTP / TFTP / SFTP reachability | 🟢 | ● | Full | Firmware/PLC-program transfer paths |
| HTTP/REST + WebSocket probe | 🟢 | ● | Full | Web HMI, embedded API |

*\*PTP software timestamping gives offset estimates, not sub-µs precision — hardware NIC support needed for grandmaster-grade measurement. Fine for a "clock is skewed" verdict.*

### 6.2 Industrial Ethernet tier

| Protocol | Lib | Effort | Mode | Diagnostic depth |
|---|---|---|---|---|
| **Modbus TCP** (master + slave sim) | 🟢 pymodbus | ● | Full | Exception-code verdicts, gateway-vs-slave isolation |
| **EtherNet/IP + CIP** | 🟢 pycomm3 / OpENer | ●● | Full | Identity, **Forward Open/Close** (RPI, timeout mult, O↔T sizing), Class 1 vs Class 3, **electronic-keying mismatch**, backplane slot routing, **EDS ingestion** |
| **S7comm** (300/400) | 🟢 Snap7 | ●● | Full | Rack/slot, PDU negotiation, DB/M/I/Q reads, **SZL diagnostic reads**, protection-level detect |
| **S7comm-Plus** (1200/1500 optimized) | 🟡 Snap7 partial | ●●● | Full | Symbolic access to optimized DBs is **incompletely reverse-engineered** — Siemens moves it |
| **PROFINET** | 🟡 | ●●● | Full/Observe | DCP identify/flash/set-IP, **GSDML** module match, **IOPS/IOCS per slot**, I&M0–4, **MRP ring status**, alarm buffer, RT/IRT jitter stats |
| **Mitsubishi SLMP / MELSEC** | 🟡 | ●● | Full | Device batch R/W (D/M/X/Y/R/ZR), 3E/4E framing, error-code table |
| Omron **FINS** | 🟡 | ●● | Full | Memory-area read, node routing (UDP/TCP) |
| Beckhoff **ADS** | 🟢 pyads | ●● | Full | AMS NetID/port, symbol browse, notification subscribe |
| **CC-Link IE** Field/Control | 🔴 | ●●● | Observe | Cyclic + transient decode; vendor tooling dominates |
| AB **PCCC / DF1-over-Ethernet** | 🟡 | ●● | Full | Legacy SLC/PLC-5 |
| **GE SRTP**, Yokogawa **Vnet/IP** | 🔴 | ●●● | Observe | Niche; decode-first |
| **EtherCAT, POWERLINK, SERCOS III, Mechatrolink** | 🔴 | ●●● | **Observe** | **Cannot be a real-time master from userspace.** Tap + decode only. |

### 6.3 Utility / building / energy tier

| Protocol | Lib | Effort | Mode | Diagnostic depth |
|---|---|---|---|---|
| **BACnet/IP + MS/TP** | 🟢 bacpypes / BACnet4J | ●● | Full | Who-Is/I-Am, object/property browse, **COV subscribe**, priority-array, BBMD/foreign-device check |
| **DNP3** | 🟢 OpenDNP3 / stepfunc | ●●● | Full | Integrity poll (class 0), event classes 1/2/3, **unsolicited responses**, IIN flags, secure-auth v5 |
| **IEC 60870-5-104 / -101** | 🟢 lib60870 | ●● | Full | ASDU decode, interrogation, clock sync, command confirm |
| **IEC 61850 MMS** | 🟢 libiec61850 | ●●● | Full | LN/DO/DA model browse |
| **IEC 61850 GOOSE** | 🟢 libiec61850 | ●●● | Observe | **stNum/sqNum tracking**, retransmission timing, config-rev mismatch (needs L2 + mirror port) |
| **IEC 61850 Sampled Values (9-2LE)** | 🟡 | ●●● | Observe | SV stream integrity, sample-count continuity |
| **ICCP / TASE.2** (IEC 60870-6) | 🔴 | ●●● | Observe | Control-center links; rare, decode-first |
| IEC 62351 (security layer) | 🟡 | ●● | Observe | Status alongside 61850/104 |
| **SunSpec Modbus** (inverters) | 🟢 pysunspec2 | ●● | Full | Model-map decode over Modbus |
| **OCPP 1.6 / 2.0.1** (EV charging) | 🟢 | ●● | Full | Boot/heartbeat/transaction messages |
| IEEE 2030.5 / SEP2, OpenADR | 🟡 | ●● | Full | DER + demand-response |
| **ANSI C12.18 / C12.22** (metering) | 🟡 | ●● | Full | Table read, meter identity |
| **M-Bus / wM-Bus** | 🟢 | ●● | Full/HW | Meter register profiles (wM-Bus needs radio) |
| **KNX / KNX-IP** | 🟢 | ●● | Full | Group-address monitor, device browse |
| **LonWorks/LonTalk**, **DALI-2** | 🟡 | ●● | Full/HW | Building + lighting (interface hardware) |

### 6.4 IIoT / broker / data tier

| Protocol | Lib | Effort | Mode | Diagnostic depth |
|---|---|---|---|---|
| **OPC UA** (client + server sim) | 🟢 open62541 / Milo | ●●● | Full | Browse, subscribe, **security-policy + cert-chain audit**, GDS enrollment |
| **OPC UA PubSub** | 🟡 | ●●● | Full/Observe | UADP over UDP-multicast *and* over MQTT |
| **OPC Classic (DA/AE/HDA / DCOM)** | 🟡 | ●●● | Full | Windows-only; **DCOM permission diagnosis is the real pain** |
| **MQTT 3.1.1 / 5** | 🟢 paho | ● | Full | Connect, QoS behavior, **retained + LWT inspection**, topic-tree explorer, session-takeover detect |
| **Sparkplug B** | 🟢 Eclipse Tahu | ●● | Full | **NBIRTH/DBIRTH alias resolution**, seq-gap detection, **rebirth trigger**, metric-tree diff, stale-tag detect |
| **MTConnect** | 🟡 | ●● | Full | Agent probe/current/sample |
| **DDS / RTPS** | 🟡 | ●●● | Observe | Robotics + industrial pub/sub decode |
| **CoAP, LwM2M** | 🟢 | ●● | Full | Constrained-device REST + device mgmt |
| **AMQP** | 🟢 | ●● | Full | Broker messaging |
| **Kafka** consumer | 🟢 | ●● | Full | Topic tail, offset/lag |
| **InfluxDB line protocol** | 🟢 | ● | Full | Sink-probe validation |
| Azure IoT Hub / AWS IoT MQTT | 🟢 | ●● | Full | Cert/SAS connection diagnostics |

### 6.5 IoT / edge / wireless tier

*Software is buildable; each is gated on its specific radio dongle (Mode = HW).*

| Protocol | Lib | Effort | Mode | Diagnostic depth |
|---|---|---|---|---|
| **Zigbee** (coordinator radio) | 🟢 zigpy | ●● | HW | Network scan, **LQI/RSSI map**, join/leave events, cluster/attribute read |
| **BLE GATT** | 🟢 bleak | ●● | HW | Scan, service/characteristic browse, notify subscribe |
| **Z-Wave** | 🟡 | ●● | HW | Mesh membership, commissioning state |
| **Thread / Matter** | 🟡 | ●●● | HW | Commissioning + mesh diagnostics |
| **LoRaWAN** | 🟡 | ●● | HW | **Join-request/accept decode**, uplink/downlink framing, RSSI/SNR, DevAddr track |
| **Tuya-local / ESPHome / HA API** | 🟢 tinytuya | ●● | Full | Local-key device probe |
| **Wi-Fi scan** | 🟢 | ● | HW | SSID/BSSID/channel/RSSI survey (RF contention on plant Wi-Fi) |
| **WirelessHART / ISA100.11a** | 🔴 | ●●● | HW | Mesh diagnostics via gateway interface |

### 6.6 Serial / fieldbus tier

| Protocol | Lib | Effort | Mode | Diagnostic depth |
|---|---|---|---|---|
| **Modbus RTU / ASCII** | 🟢 pymodbus | ● | Full | Auto-baud/parity detect, framing analysis |
| **DF1** | 🟡 | ●● | Full | Legacy AB serial |
| Raw ASCII terminal | 🟢 | ● | Full | Framing analyzer, hex/ASCII toggle |
| **HART / HART-IP** | 🟡 | ●● | Full/HW | Device variables, command 0/3 |
| **PROFIBUS DP** | 🔴 | ●●● | Observe | Via diagnostic tap only |
| **IO-Link** | 🟡 | ●● | HW | Via master interface |

### 6.7 Safety protocols — decode only (considered position)

**PROFIsafe, CIP Safety, openSAFETY, FSoE.** `safety_locked: true` — **decode and diagnose only. No write path exists in code (absent, not gated).** This is a deliberate engineering position, not a missing feature, and a double-gate-with-clause does *not* change it:

- **A write path invalidates the certified safety case.** The safety communication layer is certified as part of a validated loop (IEC 61508 / 62061 / ISO 13849). The SIL/PL rating assumes safety telegrams originate only from the certified F-Host/F-Device pair. An external writer means the function can no longer be claimed to deliver its rated risk reduction — it changes the compliance status of the whole machine, which no warning label restores.
- **The protocols exist specifically to reject you.** PROFIsafe's consecutive number, timeout watchdog, and safety CRC are there precisely so a non-safety node cannot inject a valid safety telegram. A write path is, by construction, a tool to defeat those integrity mechanisms — i.e., to spoof a safety system. Intent doesn't change what the artifact is.
- **A click-through clause transfers no real liability.** "The operator accepted a warning" is not a defense — for CCI as vendor or for the engineer — if a defeated safety function injures someone. It manufactures a feeling of coverage without the substance.

**What the tool does instead — full safety *diagnostics*, which is the actual troubleshooting need:** F-Parameters (`F_Dest_Add`, `F_Source_Add`, `F_WD_Time`), CRC-signature match, consecutive-number / watchdog timing, passivation/reintegration state, and — most importantly — **why a function passivated** (device dropped, watchdog expired, CRC mismatch, reported wiring fault). The legitimate "get it running again" action (reintegration acknowledgment) is a **standard** tag write that the certified safety program reads and gates internally — so Fieldscope performs it over standard protocols while the safety controller stays in charge of whether reintegration is safe. The safety layer itself is never written.

---

## 7. UI structure

### Global chrome (persistent top bar)

`SOURCE` adapter selector · `VLAN` tag · **LIVE / READ-ONLY** state pill · **ARM** toggle (dark until deliberately enabled) · capture-recording indicator · link policy · theme.

### Left rail — workspace navigation

```
HOME                    (overview: saved targets, sessions, protocols ready)
CONNECTIONS             (reusable target profiles)
▾ DISCOVERY
    IP scanner · Topology · Time source (NTP/PTP)
▾ INDUSTRIAL PROTOCOLS
    EtherNet/IP · PROFINET · Modbus · S7 · SLMP · FINS · ADS …
▾ UTILITY
    BACnet · DNP3 · IEC 61850 · IEC 104 · SunSpec · OCPP …
▾ IIoT
    OPC UA · MQTT · Sparkplug B · MTConnect · Kafka …
▾ WIRELESS / IoT
    Zigbee · BLE · LoRaWAN · Wi-Fi survey · Tuya-local …
▾ TOOLS
    Packet capture · SNMP · Serial · TCP/UDP · TLS
EVIDENCE
    Sessions · Results · Reports
```

### Every protocol workspace uses ONE repeated layout

Learn it once, use it everywhere. Tabs are driver-capability-driven — unavailable verbs grey out.

```
┌─ Target bar: profile ▾ | 10.200.100.68:502 | timeout 3s | [CONNECT] ─┐
├──────────────────────────────────────────────────────────────────────┤
│  Connect │ Identify │ Browse │ Monitor │ Diagnose │ Raw                │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   (tab content)                                                      │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│  Evidence: 3 artifacts captured               [ Save ]  [ Export ]   │
└──────────────────────────────────────────────────────────────────────┘
```

- **Diagnose** — the differentiator. Renders verdicts (§5) with severity color + next-steps, not raw data.
- **Monitor** — jitter, min/avg/max RTT, retry count, rolling sparkline. Timing bugs are the hard ones.
- **Raw** — always shows the hex bytes on the wire. Lets the engineer verify the tool.

### Evidence & reporting view

Session timeline · filterable result grid · **session diff** ("this worked yesterday") · export to PDF/HTML commissioning report with credential redaction.

---

## 8. Cross-cutting subsystems

| Subsystem | Purpose |
|---|---|
| **Adapter routing** | Multi-NIC binding, per-target interface selection, temporary static-IP profiles, VLAN tagging. Essential when the laptop straddles OT and IT VLANs. |
| **Device catalog** | Ingests EDS / GSD-GSDML / CSP+ / SunSpec / BACnet EPICS. Turns raw instance/register numbers into named, typed points automatically. |
| **Multicast diagnostics engine** | Shared by CIP I/O, PROFINET, GOOSE, SV, and OPC UA PubSub — the single biggest silent-failure class in OT. |
| **Precision-timing correlation** | Every frame + protocol event share one PTP/NTP-anchored timeline, so a packet capture and a Sparkplug seq-gap line up to the microsecond. |
| **Rules engine** | Declarative YAML rulepacks (§5), hot-loadable, so field signatures are added without a rebuild. |
| **Credential vault** | OS-keychain-backed. Never included in a session export. |
| **Plugin SDK** | Third parties (or you, per-customer) ship a driver as a signed assembly against the manifest. |
| **Capture core** | Bounded passive Npcap/libpcap capture with industrial decoders; can delegate exotic decode to bundled `tshark`. |

---

## 9. Evidence & data model

**Storage split:** SQLite for structured metadata/results (queryable, diffable); flat pcap/blob files for raw byte streams and captures (referenced by path from SQLite). Keeps the DB small and captures portable.

```
Target
  id · name · address · protocol · saved_creds_ref · notes

Session
  id · target_id · started_at · ended_at · operator
  arm_state · source_adapter · vlan · clock_anchor (PTP/NTP offset)

Artifact                          ← the atomic unit, one per verb call
  id · session_id · verb · timestamp_ptp
  raw_ref (path to bytes) · decode (json) · result (json)
  verdict_id? (nullable)

Verdict
  id · artifact_id · rule_id · severity (ok|info|warn|error)
  title · detail · next_steps[]

Report
  id · session_ids[] · generated_at · format (pdf|html)
  redaction_profile
```

**Replay** re-streams a session's artifacts in timeline order. **Diff** aligns two sessions by verb + target and highlights changed results/verdicts — the "what changed since it last worked" workflow.

---

## 10. Technology stack

**Recommended: .NET 8 + Avalonia.**
- Single codebase for Windows + Linux (field laptops are mixed).
- Strong industrial library ecosystem on .NET (Snap7 bindings, SharpPcap/Npcap, serial).
- Native raw-socket + pcap access with low overhead.

**Alternative: Rust + Tauri** if a smaller binary and tighter memory footprint matter more than library breadth (you'd write more from scratch).

**Avoid Electron** — you need raw socket + pcap access with low overhead; the runtime tax and permission friction aren't worth it for an instrument.

**Hard platform facts:**
- **Administrator / root + Npcap** required for any raw-Ethernet, L2, or capture work. Shapes install + deployment.
- **L2 protocols (GOOSE, SV, LLDP, DCP)** need a **mirror/SPAN port** on the switch to observe — document this in the field guide.
- Radio tiers need their **specific dongle** — the product is "app + this coordinator/adapter," not pure software, for wireless.

---

## 11. Buildability summary

The plan is realistic, but "buildable" splits four ways — the honest axis is **observe vs participate**, not hard vs easy.

- **The decode side is largely solved.** Wireshark already dissects almost everything here; exotic decoders can shell out to `tshark` rather than be reimplemented. You're mostly building *interaction, diagnosis, and evidence on top of* solved decoders.
- **Mature libraries carry the interactive load:** Snap7, pycomm3/OpENer, lib60870 + libiec61850, OpenDNP3, bacpypes/BACnet4J, open62541 + Eclipse Milo, Eclipse Tahu, SharpPcap/Npcap.
- **Real-time buses (EtherCAT, SERCOS III, POWERLINK, PROFIBUS) are observe-only.** You physically cannot be a real-time master from a Windows/Linux userspace app. Tap and decode — never participate.
- **Wireless is hardware-gated.** Each radio protocol needs its dongle; it's "app + adapter," not pure app.
- **Known soft spots:** S7comm-Plus symbolic access is incompletely reverse-engineered; software PTP gives offset estimates not sub-µs precision; OPC Classic DCOM is a Windows permission nightmare (worst value-to-pain ratio in the catalog).
- **Licensing** (CIP/ODVA, PROFINET/PI, IEC standards) barely affects *personal* buildability — open libs absorbed much of it — but constrains a *commercial* product's completeness and legality.

**Solo-dev reality:** IT tier + Modbus + OPC UA + MQTT/Sparkplug + EtherNet/IP explicit + S7-via-Snap7 + BACnet + DNP3 is a realistic multi-month build. The long tail (PROFINET IRT stats, CC-Link IE, every radio, real-time-bus participation) is where months become years. **The shippable product is ~80% of the value from ~30% of the protocols — all of which have proven libraries.**

---

## 12. Build sequencing / roadmap

1. **Skeleton + driver contract + evidence store** — the frame, no protocols. Prove the manifest/verb/artifact loop end-to-end with a single trivial driver (ICMP).
2. **IT tier** — immediately useful, low risk, proves the UI pattern and the Diagnose-verdict model against easy protocols.
3. **Modbus TCP + EtherNet/IP explicit** — highest demand; validates the contract against two very different protocol shapes.
4. **Packet capture core** with industrial decoders (+ `tshark` delegation).
5. **OPC UA + MQTT/Sparkplug B** — plays directly into UNS work; strongest IIoT story.
6. **S7 (Snap7) + BACnet + DNP3** — depth in controller + utility domains.
7. **PROFINET, SLMP, FINS/ADS** — vendor-specific depth.
8. **Rules engine maturity + reporting/diff** — turns a tool into a *deliverable* (commissioning reports, session diffs).
9. **Wireless tiers** — as hardware and demand justify; each behind its dongle.
10. **Plugin SDK public** — let per-customer drivers ship without touching core.

**Guiding rule:** every phase must produce evidence and a verdict, or it isn't done. The evidence loop is the product — protocols are content poured into it.

---

*Fieldscope · Connected Core Industries · design specification*
