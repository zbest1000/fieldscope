// Sim lab: every protocol simulator on fixed ports in one process. Used by the
// docker-compose `simlab` service (and handy standalone) so the whole workbench
// can be exercised — including fault verdicts — with no hardware and no
// network. Ports are >1024 so the lab runs unprivileged in a container.
//
//   node server/test/sim-lab.js
//
// Then point Fieldscope at (hostname: `simlab` inside compose, else localhost):
//   modbus-tcp   :5020   healthy slave     |  :5021  gateway with dead RTU (0x0B)
//   ethernet-ip  :44818  operational PLC   |  :44819 major-unrecoverable fault
//   mqtt         :1883   open broker       |  :1884  auth-required broker
//   snmp         :1161/udp  switch with a flaky cable on eth1 (community: public)
//   bacnet       :47808/udp operational controller | :47809 non-operational
//   dnp3         :20000  healthy outstation | :20001 restart IIN set
//   iec104       :2404   healthy station (GI→3 points) | :2405 silent (no STARTDT con)
//   s7comm       :1102   S7-300 @ rack0/slot2 (refuses wrong rack/slot)
//   sparkplug          a Sparkplug B edge node publishing to the :1883 broker
//                      (group Plant1 / node Line3; use the mqtt :1883 target)
//   opcua        :4840   OPC UA server (UACP Hello/Ack handshake)
//   dns          :5354/udp  DNS zone plant.local (plc/gw, A/MX/TXT/NS) — point the
//                          dns driver at 127.0.0.1:5354 and read a record type
//   dhcp         :6767/udp  DHCP server (single OFFER) — point the dhcp driver's
//                          server=127.0.0.1 server_port=6767
//   profinet-dcp :34964/udp DCP responder (2 devices) — point the profinet-dcp
//                          driver's responder_port=34964
//   (ipscan needs no sim — point it at 127.0.0.1 and scan the ports above)

import { startModbusSim } from './modbus-sim.js';
import { startEipSim } from './eip-sim.js';
import { startMqttBroker } from './mqtt-broker.js';
import { startSnmpAgent } from './snmp-agent.js';
import { startBacnetSim } from './bacnet-sim.js';
import { startDnp3Sim } from './dnp3-sim.js';
import { startIec104Sim } from './iec104-sim.js';
import { startS7Sim } from './s7-sim.js';
import { startSparkplugNode } from './sparkplug-node.js';
import { startOpcuaSim } from './opcua-sim.js';
import { startDhcpSim } from './dhcp-sim.js';
import { startProfinetDcpSim } from './profinet-dcp-sim.js';
import { startDnsSim } from './dns-sim.js';

const services = [];

async function up(name, detail, fn) {
  const svc = await fn();
  services.push({ name, svc });
  console.log(`[sim-lab] ${name.padEnd(22)} ${detail}`);
  return svc;
}

console.log('[sim-lab] starting protocol simulators…');

await up('modbus-tcp healthy', ':5020  (holding regs 1000+n)', () => startModbusSim({ port: 5020 }));
await up('modbus-tcp gw-dead', ':5021  (every request → exception 0x0B)', () =>
  startModbusSim({ port: 5021, exception: 0x0b }));
await up('ethernet-ip healthy', ':44818 (Operational, owned+configured)', () => startEipSim({ port: 44818 }));
await up('ethernet-ip faulted', ':44819 (Major Unrecoverable Fault)', () =>
  startEipSim({ port: 44819, status: 0x0800, state: 5, productName: 'Fieldscope Faulted Drive', deviceType: 0x02 }));
await up('mqtt open', ':1883', () => startMqttBroker({ port: 1883 }));
await up('mqtt auth-required', ':1884  (user "ops" / pass "secret")', () =>
  startMqttBroker({ port: 1884, username: 'ops', password: 'secret' }));
await up('snmp flaky-cable', ':1161/udp (community "public", errors on eth1)', () =>
  startSnmpAgent({
    port: 1161,
    interfaces: [
      [1, 'eth0 uplink', 1_000_000_000, 1, 1, 0, 0, 0, 0],
      [2, 'eth1 plc', 100_000_000, 1, 1, 3, 917, 0, 12],
      [3, 'eth2 spare', 100_000_000, 2, 2, 0, 0, 0, 0],
    ],
  }));
await up('bacnet operational', ':47808/udp (device 260001, Automated Logic)', () =>
  startBacnetSim({ port: 47808, deviceInstance: 260001, vendorId: 36, systemStatus: 'operational' }));
await up('bacnet non-operational', ':47809/udp (device 260002, non-operational)', () =>
  startBacnetSim({ port: 47809, deviceInstance: 260002, vendorId: 5, systemStatus: 'non-operational' }));
await up('dnp3 healthy', ':20000  (outstation 1024, IIN clean)', () =>
  startDnp3Sim({ port: 20000, outstation: 1024, iin1: 0x00, iin2: 0x00 }));
await up('dnp3 restart-set', ':20001  (outstation 1025, device-restart IIN)', () =>
  startDnp3Sim({ port: 20001, outstation: 1025, iin1: 0x80, iin2: 0x00 }));
await up('iec104 healthy', ':2404   (common address 1, GI returns 3 points)', () =>
  startIec104Sim({ port: 2404, commonAddress: 1 }));
await up('iec104 silent-link', ':2405   (never confirms STARTDT)', () =>
  startIec104Sim({ port: 2405, startdt: false }));
await up('s7comm S7-300', ':1102   (6ES7 315, rack 0/slot 2; refuses wrong slot)', () =>
  startS7Sim({ port: 1102, acceptRack: 0, acceptSlot: 2, refuseWrongSlot: true }));
await up('sparkplug edge node', '→ mqtt :1883 (Plant1/Line3, periodic rebirth)', () => {
  const node = startSparkplugNode({ brokerPort: 1883, group: 'Plant1', node: 'Line3', intervalMs: 200, rebirthEvery: 20 });
  return { close: () => node.stop() };
});
await up('opcua server', ':4840   (UACP Hello/Ack handshake)', () => startOpcuaSim({ port: 4840 }));
await up('dns server', ':5354/udp (zone plant.local: plc/gw + A/MX/TXT/NS)', () => startDnsSim({ port: 5354 }));
await up('dhcp server', ':6767/udp (offers 10.10.0.50, single server)', () => startDhcpSim({ port: 6767 }));
await up('profinet-dcp responder', ':34964/udp (plc-line3 + io-station-1)', () => startProfinetDcpSim({ port: 34964 }));

console.log(`[sim-lab] ${services.length} simulators up — Ctrl-C to stop`);

function stop() {
  console.log('[sim-lab] stopping');
  for (const { svc } of services) {
    try {
      if (svc.close) svc.close();
      else if (svc.server) svc.server.close();
    } catch { /* going down anyway */ }
  }
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
