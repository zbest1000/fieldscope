# Driver reference

Every protocol in Fieldscope is a **driver**: a capability manifest plus an
implementation of whichever contract verbs apply. The rest of the workbench —
UI, evidence store, rules engine, the ARM double-gate — is written once against
that contract (`server/src/contract/contract.js`), so a driver never touches
those layers. Adding a protocol is one file in `server/src/drivers/`.

## The contract verbs

The UI renders a tab per declared verb (in this order), plus a **Raw** tab that
hex-dumps the last artifact:

| Verb | What it means |
|---|---|
| `connect` | prove the endpoint is live (open the session / handshake) |
| `identify` | who/what is there — identity, capabilities, first status |
| `browse` | enumerate what the endpoint exposes (points, topics, ports, topology) |
| `read` | pull specific values |
| `write` | change a value — **always** behind ARM + per-write confirm + read-back + audit (§4.1) |
| `monitor` | sample over time → RTT / jitter / loss sparkline |
| `diagnose` | correlate results + transport facts through a YAML rulepack → a plain-English **verdict** |

Every verb returns a stored, replayable **artifact** (raw bytes + decode +
verdict). Diagnose renders "what is wrong and why", not a raw dump. Writes are
marked ⚡ below and clear the double-gate.

Each driver also ships a live **simulator** (`server/test/*-sim.js`, including
fault variants), so everything runs and is tested with no hardware. The same
simulators power the `docker compose --profile lab` plant floor.

---

## Discovery — "what is on this network"

### ICMP (ping) · `icmp.js`
Reachability and latency. `identify` pings the host; `monitor` streams RTT,
jitter, and packet loss as a rolling sparkline. Baselines a link and exposes
intermittent loss. Raw ICMP needs `NET_RAW`.

### IP Scanner · `ipscan.js`
TCP host/port discovery. `read` sweeps a CIDR (TCP-ping) for live hosts;
`browse` scans a port range; `identify` scans a curated common-port list
(heavy on OT ports) and names services with a light banner grab; `connect`
checks one port's state. Concurrency-pooled and bounded so it's safe on a live
segment. **Diagnose** flags reachable industrial-control services / remote-access
surface.

### DHCP / BOOTP ⚡ · `dhcp.js` · udp 67
Address service inspection and assignment. `identify` sends a DISCOVER and
decodes every OFFER's options (subnet / router / DNS / lease). **Diagnose**
flags a **rogue / multi-server** segment (two servers answering one DISCOVER).
`write` assigns an address to a MAC in either **DHCP** (DORA: DISCOVER → REQUEST
→ ACK) or classic **BOOTP** (single request/reply, no lease) mode.

### DNS · `dns.js` · 53
Forward and reverse resolution (`identify`), and typed record lookups
(`read` — A / AAAA / MX / TXT / NS / CNAME / SOA / PTR) that can query a chosen
DNS server directly ("does *this* server resolve X"). Surfaces resolution
failures and forward/reverse mismatches.

---

## Tools — IT-tier fundamentals

### TCP/UDP Probe · `tcpudp.js`
Raw port-state check (open / closed / filtered) with a banner grab — the
generic connectivity primitive under everything else.

### TLS / Cert Inspector · `tls.js` · 443
TLS handshake and certificate-chain decode (subject / issuer / validity / SAN).
**Diagnose** flags expiry and hostname mismatches.

### NTP / SNTP · `ntp.js` · udp 123
A single SNTP exchange (RFC 4330) that answers "is this time server actually
serving good time?" `identify` decodes the server's **stratum**, **leap
indicator**, root delay/dispersion, and **reference source** (GPS/PPS for
stratum ≤ 1, upstream IP otherwise), and computes the **local clock offset** and
round-trip delay from the four NTP timestamps. `monitor` streams the offset so a
drifting or hunting clock walks off zero. **Diagnose** flags an **unsynchronized**
server (stratum 0/16 or the alarm leap bit) and a **>1s local offset** — the
signal that event timestamps captured here won't line up with device/SCADA time.
Clock sync underpins every time-tagged point (CP56Time2a, Sparkplug) and the
evidence store's `clock_anchor`.

### HTTP / REST · `http.js` · 80/443
Probes an HTTP/REST endpoint — the JSON status/health surface that edge
gateways, inverters, and building controllers expose. `identify` reports the
**status class**, server, content type, and latency; `read` decodes a **JSON
body into a dotted point tree** (or a bounded text preview); `monitor` streams
latency. **Diagnose** turns the status class into a verdict: 5xx (server
faulting), 4xx (auth/wrong-path), 3xx (redirect, often http→https), 2xx healthy.
TLS certs are **not** validated here (use the TLS driver for the cert audit) so a
box with a self-signed cert still reports its real status.

### SNMP v1/v2c · `snmp.js` · udp 161
GET / WALK over the interface table (`ifTable`). Reads **per-port error
counters** so a **flaky cable** shows up as errors climbing on one port while
its neighbours stay clean — the flagship "which cable is bad" verdict.

---

## Industrial — plant-floor control

### Modbus TCP ⚡ · `modbus.js` · 502
MBAP-framed register/coil access. `read` pulls holding / input registers and
coils / discrete inputs, and **interprets register runs** as int16 / uint32 /
int32 / float32 / **uint64 / int64 / float64** — combining two registers into a
32-bit value or four into a 64-bit one — with every Modbus **byte/word order**
quirk covered: `ABCD` (big-endian), `CDAB` (word-swapped), `BADC` (byte-swapped),
`DCBA` (little-endian). This is the constant field question ("is this a float,
and in which order does *this* device store it?") — flip the order until the
value reads sane. Legacy `big`/`little` map to `ABCD`/`CDAB`. 64-bit integers
beyond JavaScript's safe range are returned as exact decimal strings (no
precision loss). A register run can also be read as an **ASCII/UTF-8 string**
(device name / serial), and any numeric read can carry a **linear scale** (`raw
× gain + offset`) so a raw `0–27648` shows as `0–100 %` in real engineering
units. `write` sets a single coil (FC05) / register (FC06), or a wide
**setpoint** across two or four registers via FC16 in the chosen byte order — all
behind the double-gate with read-back. **Diagnose** decodes exception codes; the
flagship is a gateway whose downstream RTU is dead (exception 0x0B) vs a healthy
slave.

### EtherNet/IP + CIP · `ethernet-ip.js` · 44818
CIP Identity object via List Identity (`identify`), decoding the **status word +
device state**. `read` registers a session and runs **CIP Get_Attribute_Single**
on a class / instance / attribute (Identity attributes decoded by number; other
classes returned raw), reporting the CIP general status. Flagship verdict: a
drive reporting a Major Unrecoverable Fault.

### S7comm · `s7comm.js` · 102
ISO-on-TCP (TPKT / COTP) connect at a specific **rack/slot**, then an SZL read
for order number + firmware (`identify`). `read` runs an S7 **ReadVar** of a
data block or memory area (DB / M / I / Q), returning the raw bytes with optional
int16 / uint32 / float32 (big-endian) interpretation and the S7 return code.
Flagship: the wrong rack/slot is silently refused (looks like an offline PLC).

### PROFINET DCP / LLDP ⚡ · `profinet-dcp.js` · raw L2
Two protocols joined. **DCP** `identify` runs Identify-All discovery (station
name / IP / vendor / role); `browse` reconstructs the **physical port topology**
from **LLDP** (each device's ports and which port cables to which neighbour
port), falling back to a logical subnet view when no LLDP is seen; `write` is a
**DCP Set** that commissions station name / IP / subnet / gateway (ARM-gated,
Identify read-back). Flagship verdicts: duplicate station name, unconfigured IP
(0.0.0.0). Real DCP/LLDP are raw Ethernet (`requires_l2`); the codecs run over a
UDP test harness here.

---

## Utility — SCADA / telecontrol

### BACnet/IP · `bacnet.js` · udp 47808
Who-Is / I-Am discovery + device-object read for **system status**. `read`
pulls object properties (system-status / object-name / vendor-name / model-name);
`browse` reads the device **object-list** and enumerates its objects (analog /
binary I/O, values, schedules …). Flagship: a controller reporting non-operational.

### DNP3 · `dnp3.js` · 20000
Link-status addressing check + Class 0 integrity read. `identify` decodes the
**IIN** (Internal Indications) word — device-restart, need-time, event-buffer
overflow, configuration-corrupt; `read` / `browse` decode the Class 0 objects
(binary inputs g1v2, analog inputs g30v1-5, counters) into a point table with
per-point flags (online / comm-lost / restart). Wire-correct CRC (checked
against the opendnp3 reference).

### IEC 60870-5-104 ⚡ · `iec104.js` · 2404
APCI (U / S / I frames) + ASDU decode. `connect` runs the STARTDT handshake;
`read` / `browse` issue a **General Interrogation** and list the returned points
(including **CP56Time2a** timestamps on time-tagged events); `write` operates a
point with a **single command (C_SC_NA_1)** using the real **select-before-
operate** handshake through the double-gate. **Diagnose** verdicts: link not
activated (no STARTDT con), **unknown common address (COT 46)** — the top "link
up, no data" misconfig — and GI rejected.

---

## IIoT — message-bus / OT-IT bridge

### MQTT 3.1.1 ⚡ · `mqtt.js` · 1883
CONNECT / CONNACK, `browse` the subscribed topic tree, `write` publishes as an
ARM-gated write. Flagship: auth-required / not-authorized CONNACK verdicts.

### Sparkplug B · `sparkplug.js` · 1883
Decodes the NBIRTH / NDATA / NDEATH lifecycle with a dependency-free protobuf
codec; `browse` shows the node tree with lifecycle state; `read` resolves metric
**aliases → names** from the births and shows the latest metric values per node.
Detects **sequence gaps and node death** per edge node.

### CoAP · `coap.js` · udp 5683
The constrained-device REST analog of HTTP (RFC 7252) — a compact binary
request/response over UDP that battery/bandwidth-limited IoT sensors and LwM2M
endpoints speak. `identify` and `browse` GET **`/.well-known/core`** and decode
the **CoRE Link Format** (RFC 6690) into a resource tree, each entry with its
resource type (`rt`) and interface (`if`); `read` GETs an arbitrary Uri-Path and
returns the payload. **Diagnose** decodes the response class into a verdict:
2.xx healthy, 4.xx (4.04 wrong path / 4.01 unauthorized), 5.xx server fault, or
unreachable. Raw binary CoAP codec (header + delta-encoded options + payload),
dependency-free.

### OPC UA · `opcua.js` · 4840
UACP Hello / Acknowledge handshake and negotiated transport limits (`connect` /
`identify`); decodes protocol-error StatusCodes. `browse` opens a
SecurityPolicy-**None** secure channel (OpenSecureChannel) and runs
**GetEndpoints**, enumerating every endpoint the server offers with its security
mode (None / Sign / SignAndEncrypt), security policy (Basic256Sha256 …) and
security level — the "which endpoint should my client use, and does it require
certificates" question, and the entry point to a cert-chain / policy audit. The
enumeration feeds **security verdicts**: an unauthenticated `None` endpoint
offered alongside secured ones (warn), or *only* `None` endpoints — no encrypted
option at all (error), vs. all endpoints requiring security (ok). Flagship:
endpoint-URL-invalid. Full binary codec (NodeIds, ExtensionObjects,
LocalizedText, EndpointDescription) implemented dependency-free.

---

## Adding a driver

Drop `server/src/drivers/<id>.js` exporting `manifest` + `verbs`, register it in
`server/src/drivers/index.js`, add `server/rulepacks/<id>.yaml` for diagnose
verdicts, and a `server/test/<id>-sim.js` simulator with tests. Nothing in the
UI, evidence, or rules layers changes — that plugin boundary is the point (§3).
