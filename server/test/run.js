// Fieldscope backend test suite. Exercises the whole loop the architecture is
// built around: manifest → verb → artifact → verdict → evidence → replay/diff,
// plus the double-gated write path. Runs against a local Modbus simulator so it
// needs no real hardware or network.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DriverRegistry } from '../src/drivers/index.js';
import { EvidenceStore } from '../src/evidence/store.js';
import { RulesEngine } from '../src/rules/engine.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
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
import * as profinetDcp from '../src/drivers/profinet-dcp.js';
import net from 'node:net';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

function makeStack() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fieldscope-test-'));
  const registry = new DriverRegistry();
  const store = new EvidenceStore({ dir });
  const rules = new RulesEngine({ dir: path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'rulepacks') });
  const events = [];
  const orchestrator = new Orchestrator({ registry, store, rules, emit: (e, p) => events.push({ e, p }) });
  return { dir, registry, store, rules, orchestrator, events };
}

async function main() {
  console.log('Fieldscope backend tests\n');

  // ---- contract / registry ----
  console.log('contract & registry');
  await test('all driver manifests validate against the contract', () => {
    const reg = new DriverRegistry();
    const list = reg.list();
    assert.ok(list.length >= 5, 'expected at least 5 drivers');
    for (const m of list) {
      assert.ok(m.id && m.domain && Array.isArray(m.verbs));
    }
  });
  await test('modbus manifest is write_capable with the write verb', () => {
    const reg = new DriverRegistry();
    const m = reg.manifest('modbus-tcp');
    assert.strictEqual(m.write_capable, true);
    assert.ok(m.verbs.includes('write'));
  });

  // ---- rules engine ----
  console.log('rules engine');
  await test('rulepacks load from YAML', () => {
    const { rules } = makeStack();
    const packs = rules.listPacks().map((p) => p.rulepack);
    assert.ok(packs.includes('modbus-tcp'));
    assert.ok(packs.includes('icmp'));
  });
  await test('gateway-slave-dead rule matches exception 0x0B', () => {
    const { rules } = makeStack();
    const verdicts = rules.evaluate('modbus-tcp', {
      transport: { tcp_connect: 'success' },
      response: { exception_code: 0x0b },
    });
    assert.strictEqual(verdicts[0].rule_id, 'gateway-answers-slave-dead');
    assert.strictEqual(verdicts[0].severity, 'error');
  });
  await test('healthy rule matches echoed function code', () => {
    const { rules } = makeStack();
    const verdicts = rules.evaluate('modbus-tcp', {
      transport: { tcp_connect: 'success' },
      response: { function_code_echoed: true, exception_code: 'none' },
    });
    assert.strictEqual(verdicts[0].rule_id, 'healthy');
  });
  await test('operator forms (gte) work in icmp rulepack', () => {
    const { rules } = makeStack();
    const v = rules.evaluate('icmp', { reachable: true, loss_pct: 40 });
    assert.strictEqual(v[0].rule_id, 'high-loss');
  });
  await test('nonempty operator distinguishes [] from populated arrays', () => {
    const { rules } = makeStack();
    // Empty arrays must NOT trigger duplicate-name; populated ones must.
    const clean = rules.evaluate('profinet-dcp', { transport: { dcp: 'ok' }, dcp: { count: 2, duplicate_names: [], unconfigured: [] } });
    assert.strictEqual(clean[0].rule_id, 'devices-found');
    const dup = rules.evaluate('profinet-dcp', { transport: { dcp: 'ok' }, dcp: { count: 2, duplicate_names: ['x'], unconfigured: [] } });
    assert.strictEqual(dup[0].rule_id, 'duplicate-name');
  });

  // ---- evidence store ----
  console.log('evidence store');
  await test('artifact persists and hydrates with verdicts', () => {
    const { store } = makeStack();
    const s = store.createSession({ driver_id: 'modbus-tcp', address: '1.2.3.4:502' });
    const saved = store.saveArtifact(s.id, 'modbus-tcp', {
      verb: 'read',
      raw: { hex: 'deadbeef' },
      result: { values: [1, 2, 3] },
      verdicts: [{ severity: 'ok', title: 'fine', next_steps: [] }],
    }, Buffer.from([0xde, 0xad]));
    assert.strictEqual(saved.verb, 'read');
    assert.strictEqual(saved.verdicts.length, 1);
    assert.ok(saved.has_raw);
    const blob = store.readBlob(saved.id);
    assert.strictEqual(blob.length, 2);
  });
  await test('diff aligns two sessions and flags changes', () => {
    const { store } = makeStack();
    const s1 = store.createSession({ driver_id: 'modbus-tcp' });
    const s2 = store.createSession({ driver_id: 'modbus-tcp' });
    store.saveArtifact(s1.id, 'modbus-tcp', { verb: 'read', result: { values: [1] } });
    store.saveArtifact(s2.id, 'modbus-tcp', { verb: 'read', result: { values: [999] } });
    const rows = store.diff(s1.id, s2.id);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].changed, true);
  });

  // ---- modbus driver end-to-end against the simulator ----
  console.log('modbus driver (against simulator)');
  const sim = await startModbusSim({ port: 0 });
  await test('identify → healthy verdict from a live slave', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'modbus-tcp', host: '127.0.0.1', port: sim.port, unitId: 1 });
    const art = await orchestrator.diagnose(ses.id);
    assert.ok(art.verdicts.length > 0);
    assert.strictEqual(art.verdicts[0].severity, 'ok');
  });
  await test('read returns register values with raw bytes', async () => {
    const { orchestrator, store } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'modbus-tcp', host: '127.0.0.1', port: sim.port, unitId: 1 });
    const art = await orchestrator.runVerb(ses.id, 'read', { area: 'holding', address: 0, count: 4 });
    assert.deepStrictEqual(art.result.values, [1000, 1001, 1002, 1003]);
    // raw tx/rx bytes recorded for the Raw tab ("verify the tool")
    assert.ok(art.raw && art.raw.tx && art.raw.rx, 'expected tx/rx hex in raw');
    assert.match(art.raw.rx, /^[0-9a-f]+$/);
  });

  await test('exception 0x0B produces the gateway-slave-dead verdict', async () => {
    const exSim = await startModbusSim({ port: 0, exception: 0x0b });
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'modbus-tcp', host: '127.0.0.1', port: exSim.port, unitId: 1 });
    const art = await orchestrator.diagnose(ses.id);
    assert.strictEqual(art.verdicts[0].rule_id, 'gateway-answers-slave-dead');
    exSim.server.close();
  });

  // ---- double-gated write path (§4.1) ----
  console.log('write path (double-gate)');
  await test('write is refused when not armed', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'modbus-tcp', host: '127.0.0.1', port: sim.port, unitId: 1 });
    const prep = await orchestrator.prepareWrite(ses.id, { area: 'holding', address: 5, value: 4242 });
    await assert.rejects(() => orchestrator.confirmWrite(ses.id, prep.token), /not ARMED/);
  });
  await test('ARM requires typed confirmation', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'modbus-tcp', host: '127.0.0.1', port: sim.port });
    await assert.rejects(async () => orchestrator.arm(ses.id, 'yes'), /typed confirmation/);
  });
  await test('armed + prepared + confirmed write takes and read-back verifies', async () => {
    const { orchestrator, store } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'modbus-tcp', host: '127.0.0.1', port: sim.port, unitId: 1 });
    orchestrator.arm(ses.id, 'ARM');
    const prep = await orchestrator.prepareWrite(ses.id, { area: 'holding', address: 7, value: 4242 });
    assert.strictEqual(prep.proposed_value, 4242);
    const art = await orchestrator.confirmWrite(ses.id, prep.token);
    assert.strictEqual(art.result.ack, true);
    assert.strictEqual(art.result.read_back, 4242);
    assert.strictEqual(art.result.verified, true);
    // mandatory audit entry recorded
    const audit = store.listAudit();
    assert.ok(audit.some((a) => a.action === 'modbus-write'));
  });
  await test('a confirmation token is one-time', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'modbus-tcp', host: '127.0.0.1', port: sim.port });
    orchestrator.arm(ses.id, 'ARM');
    const prep = await orchestrator.prepareWrite(ses.id, { area: 'holding', address: 1, value: 1 });
    await orchestrator.confirmWrite(ses.id, prep.token);
    await assert.rejects(() => orchestrator.confirmWrite(ses.id, prep.token), /no matching prepared write/);
  });

  // ---- IT-tier drivers ----
  console.log('IT-tier drivers');
  await test('tcp-probe reports open against the simulator', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'tcp-probe', host: '127.0.0.1', port: sim.port });
    const art = await orchestrator.runVerb(ses.id, 'connect', { timeout: 1000 });
    assert.strictEqual(art.result.state, 'open');
  });
  await test('tcp-probe filtered/closed produces a verdict on diagnose', async () => {
    const { orchestrator } = makeStack();
    // port 1 on loopback is almost certainly closed → connection refused
    const ses = orchestrator.openSession({ driverId: 'tcp-probe', host: '127.0.0.1', port: 1 });
    const art = await orchestrator.diagnose(ses.id, { timeout: 800 });
    assert.ok(['refused', 'filtered'].includes(art.verdicts[0].rule_id));
  });

  // ---- EtherNet/IP driver against the simulator ----
  console.log('ethernet-ip driver (against simulator)');
  const eipSim = await startEipSim({});
  await test('identify decodes the CIP Identity object', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'ethernet-ip', host: '127.0.0.1', port: eipSim.port });
    const art = await orchestrator.runVerb(ses.id, 'identify', {});
    assert.strictEqual(art.result.product_name, 'Fieldscope Sim PLC');
    assert.strictEqual(art.result.vendor, 'Rockwell Automation / Allen-Bradley');
    assert.strictEqual(art.result.state, 'Operational');
    assert.ok(art.raw.tx && art.raw.rx, 'expected tx/rx hex in raw');
  });
  await test('connect registers an encapsulation session', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'ethernet-ip', host: '127.0.0.1', port: eipSim.port });
    const art = await orchestrator.runVerb(ses.id, 'connect', {});
    assert.strictEqual(art.result.registered, true);
    assert.ok(art.result.session_handle);
  });
  await test('operational device diagnoses healthy', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'ethernet-ip', host: '127.0.0.1', port: eipSim.port });
    const art = await orchestrator.diagnose(ses.id);
    assert.strictEqual(art.verdicts[0].rule_id, 'healthy');
  });
  await test('major-unrecoverable status bit produces the fault verdict', async () => {
    const faultSim = await startEipSim({ status: 0x0800, state: 5 });
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'ethernet-ip', host: '127.0.0.1', port: faultSim.port });
    const art = await orchestrator.diagnose(ses.id);
    assert.strictEqual(art.verdicts[0].rule_id, 'major-unrecoverable-fault');
    assert.strictEqual(art.verdicts[0].severity, 'error');
    faultSim.server.close();
  });
  await test('standby + unowned produces the keying/config verdict', async () => {
    const standbySim = await startEipSim({ status: 0x0000, state: 2 });
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'ethernet-ip', host: '127.0.0.1', port: standbySim.port });
    const art = await orchestrator.diagnose(ses.id);
    assert.strictEqual(art.verdicts[0].rule_id, 'standby-unowned');
    standbySim.server.close();
  });
  eipSim.server.close();

  // ---- MQTT driver against a live broker ----
  console.log('mqtt driver (against broker)');
  const broker = await startMqttBroker({});
  await test('open broker diagnoses healthy (CONNACK rc=0)', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'mqtt', host: '127.0.0.1', port: broker.port });
    const art = await orchestrator.diagnose(ses.id);
    assert.strictEqual(art.verdicts[0].rule_id, 'healthy');
  });
  await test('auth-required broker produces the not-authorized verdict', async () => {
    const authBroker = await startMqttBroker({ username: 'ops', password: 'secret' });
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'mqtt', host: '127.0.0.1', port: authBroker.port });
    const art = await orchestrator.diagnose(ses.id);
    assert.strictEqual(art.verdicts[0].rule_id, 'not-authorized');
    assert.strictEqual(art.verdicts[0].severity, 'error');
    await authBroker.close();
  });
  await test('publish goes through the double-gate and read-back verifies retained', async () => {
    const { orchestrator, store } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'mqtt', host: '127.0.0.1', port: broker.port });
    const params = { topic: 'fieldscope/test/x', payload: 'hello-42', qos: '1', retain: 'retained' };
    const prep = await orchestrator.prepareWrite(ses.id, params);
    assert.strictEqual(prep.point, 'fieldscope/test/x');
    assert.strictEqual(prep.proposed_value, 'hello-42');
    await assert.rejects(() => orchestrator.confirmWrite(ses.id, prep.token), /not ARMED/);
    orchestrator.arm(ses.id, 'ARM');
    const prep2 = await orchestrator.prepareWrite(ses.id, params);
    const art = await orchestrator.confirmWrite(ses.id, prep2.token);
    assert.strictEqual(art.result.ack, true);
    assert.strictEqual(art.result.read_back, 'hello-42');
    assert.strictEqual(art.result.verified, true);
    assert.ok(store.listAudit().some((a) => a.action === 'mqtt-publish'));
  });
  await test('browse samples the topic tree and sees the retained topic', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'mqtt', host: '127.0.0.1', port: broker.port });
    const art = await orchestrator.runVerb(ses.id, 'browse', { filter: '#', window_ms: 700 });
    const points = art.result.tree[0].points;
    const hit = points.find((p) => p.ref === 'fieldscope/test/x');
    assert.ok(hit, 'expected the retained topic in the tree');
    assert.strictEqual(hit.value, 'hello-42');
  });
  await broker.close();

  // ---- SNMP driver against a live agent ----
  console.log('snmp driver (against agent)');
  const snmpSim = await startSnmpAgent({
    interfaces: [
      [1, 'eth0 uplink', 1_000_000_000, 1, 1, 0, 0, 0, 0],
      [2, 'eth1 plc', 100_000_000, 1, 1, 3, 917, 0, 12],
    ],
  });
  await test('identify reads the system group', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'snmp', host: '127.0.0.1', port: snmpSim.port });
    const art = await orchestrator.runVerb(ses.id, 'identify', { community: 'public' });
    assert.strictEqual(art.result.name, 'fieldscope-sim-switch');
    assert.ok(art.result.uptime_days > 0);
  });
  await test('interface error counters produce the flaky-cable verdict', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'snmp', host: '127.0.0.1', port: snmpSim.port });
    const art = await orchestrator.diagnose(ses.id, { community: 'public' });
    assert.strictEqual(art.verdicts[0].rule_id, 'flaky-cable');
    assert.match(art.result.facts.interfaces.worst, /eth1 plc/);
  });
  await test('clean counters diagnose healthy', async () => {
    const cleanSim = await startSnmpAgent({});
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'snmp', host: '127.0.0.1', port: cleanSim.port });
    const art = await orchestrator.diagnose(ses.id, { community: 'public' });
    assert.strictEqual(art.verdicts[0].rule_id, 'healthy');
    cleanSim.close();
  });
  await test('wrong community string produces the no-response verdict', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'snmp', host: '127.0.0.1', port: snmpSim.port });
    const art = await orchestrator.diagnose(ses.id, { community: 'wrong', timeout: 600 });
    assert.strictEqual(art.verdicts[0].rule_id, 'no-response');
    assert.match(art.verdicts[0].title, /community/);
  });
  snmpSim.close();

  // ---- BACnet/IP driver against the simulator ----
  console.log('bacnet driver (against simulator)');
  const bacSim = await startBacnetSim({ deviceInstance: 260001, vendorId: 36, systemStatus: 'operational' });
  await test('identify decodes I-Am (device instance, vendor, segmentation)', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'bacnet', host: '127.0.0.1', port: bacSim.port });
    const art = await orchestrator.runVerb(ses.id, 'identify', {});
    assert.strictEqual(art.result.device_instance, 260001);
    assert.strictEqual(art.result.vendor, 'Automated Logic (ALC)');
    assert.ok(art.raw.tx && art.raw.rx, 'expected tx/rx hex in raw');
  });
  await test('read system-status returns operational', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'bacnet', host: '127.0.0.1', port: bacSim.port });
    const art = await orchestrator.runVerb(ses.id, 'read', { property: 'system-status' });
    assert.strictEqual(art.result.value, 'operational');
  });
  await test('read vendor-name returns the character string', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'bacnet', host: '127.0.0.1', port: bacSim.port });
    const art = await orchestrator.runVerb(ses.id, 'read', { property: 'vendor-name' });
    assert.strictEqual(art.result.value, 'Automated Logic');
  });
  await test('operational device diagnoses healthy', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'bacnet', host: '127.0.0.1', port: bacSim.port });
    const art = await orchestrator.diagnose(ses.id);
    assert.strictEqual(art.verdicts[0].rule_id, 'healthy');
  });
  await test('non-operational device produces the error verdict', async () => {
    const badSim = await startBacnetSim({ deviceInstance: 260002, vendorId: 5, systemStatus: 'non-operational' });
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'bacnet', host: '127.0.0.1', port: badSim.port });
    const art = await orchestrator.diagnose(ses.id);
    assert.strictEqual(art.verdicts[0].rule_id, 'non-operational');
    assert.strictEqual(art.verdicts[0].severity, 'error');
    badSim.close();
  });
  await test('silent address produces the no-iam BBMD verdict', async () => {
    const { orchestrator } = makeStack();
    // Bind a socket and immediately close so the port is almost certainly dead.
    const ses = orchestrator.openSession({ driverId: 'bacnet', host: '127.0.0.1', port: 47999 });
    const art = await orchestrator.diagnose(ses.id, { timeout: 600 });
    assert.strictEqual(art.verdicts[0].rule_id, 'no-iam');
    assert.match(art.verdicts[0].title, /BBMD/);
  });
  bacSim.close();

  // ---- DNP3 driver against the simulator ----
  console.log('dnp3 driver (against simulator)');
  await test('DNP3 CRC matches the opendnp3 reference algorithm', async () => {
    const { dnp3Crc } = await import('../src/drivers/dnp3.js');
    // Independent table-based reference (poly 0xA6BC, final complement).
    const table = [];
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xa6bc : c >>> 1;
      table[i] = c & 0xffff;
    }
    const ref = (buf) => {
      let c = 0;
      for (const b of buf) c = (table[(c ^ b) & 0xff] ^ (c >>> 8)) & 0xffff;
      return (~c) & 0xffff;
    };
    for (const v of [Buffer.from([0x05, 0x64, 0x05, 0xc9, 0x01, 0x00, 0x00, 0x04]), Buffer.from('0123456789')]) {
      assert.strictEqual(dnp3Crc(v), ref(v));
    }
  });
  const dnpSim = await startDnp3Sim({ outstation: 1024, iin1: 0x00, iin2: 0x00 });
  await test('connect confirms the DNP3 link status', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'dnp3', host: '127.0.0.1', port: dnpSim.port });
    const art = await orchestrator.runVerb(ses.id, 'connect', { source: 1, destination: 1024 });
    assert.strictEqual(art.result.link_confirmed, true);
    assert.strictEqual(art.result.outstation_address, 1024);
    assert.strictEqual(art.result.crc_ok, true);
  });
  await test('identify decodes the IIN word', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'dnp3', host: '127.0.0.1', port: dnpSim.port });
    const art = await orchestrator.runVerb(ses.id, 'identify', { source: 1, destination: 1024 });
    assert.strictEqual(art.result.iin_raw, '0x0000');
    assert.ok(art.raw.tx && art.raw.rx, 'expected tx/rx hex in raw');
  });
  await test('clean IIN diagnoses healthy', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'dnp3', host: '127.0.0.1', port: dnpSim.port });
    const art = await orchestrator.diagnose(ses.id, { source: 1, destination: 1024 });
    assert.strictEqual(art.verdicts[0].rule_id, 'healthy');
  });
  await test('device-restart IIN bit produces the restart verdict', async () => {
    const restartSim = await startDnp3Sim({ outstation: 1025, iin1: 0x80, iin2: 0x00 });
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'dnp3', host: '127.0.0.1', port: restartSim.port });
    const art = await orchestrator.diagnose(ses.id, { source: 1, destination: 1025 });
    assert.strictEqual(art.verdicts[0].rule_id, 'device-restart');
    restartSim.server.close();
  });
  await test('config-corrupt IIN2 bit produces the error verdict', async () => {
    const badSim = await startDnp3Sim({ outstation: 1026, iin1: 0x00, iin2: 0x20 });
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'dnp3', host: '127.0.0.1', port: badSim.port });
    const art = await orchestrator.diagnose(ses.id, { source: 1, destination: 1026 });
    assert.strictEqual(art.verdicts[0].rule_id, 'config-corrupt');
    assert.strictEqual(art.verdicts[0].severity, 'error');
    badSim.server.close();
  });
  dnpSim.server.close();

  // ---- IEC 60870-5-104 driver against the simulator ----
  console.log('iec104 driver (against simulator)');
  const iecSim = await startIec104Sim({ commonAddress: 1 });
  await test('APCI/ASDU codec round-trips STARTDT + an I-frame ASDU', async () => {
    const { buildU, buildI, buildInterrogationAsdu, parseApdu, parseAsdu } = await import('../src/drivers/iec104.js');
    const u = parseApdu(buildU(0x07));
    assert.strictEqual(u.format, 'U');
    assert.strictEqual(u.u, 'STARTDT_act');
    const i = parseApdu(buildI(5, 3, buildInterrogationAsdu(7)));
    assert.strictEqual(i.format, 'I');
    assert.strictEqual(i.ns, 5);
    assert.strictEqual(i.nr, 3);
    assert.strictEqual(i.asdu.type_id, 100);
    assert.strictEqual(i.asdu.common_address, 7);
    assert.strictEqual(i.asdu.cot, 6);
  });
  await test('connect confirms the STARTDT handshake', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'iec104', host: '127.0.0.1', port: iecSim.port });
    const art = await orchestrator.runVerb(ses.id, 'connect', { common_address: 1, timeout: 1500 });
    assert.strictEqual(art.result.startdt_confirmed, true);
  });
  await test('read returns the interrogated point list', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'iec104', host: '127.0.0.1', port: iecSim.port });
    const art = await orchestrator.runVerb(ses.id, 'read', { common_address: 1, timeout: 1500 });
    assert.strictEqual(art.result.points, 3);
    const refs = art.result.tree[0].points.map((p) => p.ref);
    assert.ok(refs.includes('IOA 1001'));
  });
  await test('healthy station diagnoses confirmed', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'iec104', host: '127.0.0.1', port: iecSim.port });
    const art = await orchestrator.diagnose(ses.id, { common_address: 1, timeout: 1500 });
    assert.strictEqual(art.verdicts[0].rule_id, 'healthy');
  });
  await test('wrong common address produces the COT-46 verdict', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'iec104', host: '127.0.0.1', port: iecSim.port });
    const art = await orchestrator.diagnose(ses.id, { common_address: 99, timeout: 1500 });
    assert.strictEqual(art.verdicts[0].rule_id, 'unknown-common-address');
    assert.strictEqual(art.verdicts[0].severity, 'error');
  });
  await test('a station that never confirms STARTDT produces the silent-link verdict', async () => {
    const silentSim = await startIec104Sim({ startdt: false });
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'iec104', host: '127.0.0.1', port: silentSim.port });
    const art = await orchestrator.diagnose(ses.id, { common_address: 1, timeout: 1000 });
    assert.strictEqual(art.verdicts[0].rule_id, 'no-startdt');
    silentSim.close();
  });
  await test('a negative GI confirm produces the gi-rejected verdict', async () => {
    const negSim = await startIec104Sim({ giNegative: true });
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'iec104', host: '127.0.0.1', port: negSim.port });
    const art = await orchestrator.diagnose(ses.id, { common_address: 1, timeout: 1500 });
    assert.strictEqual(art.verdicts[0].rule_id, 'gi-rejected');
    negSim.close();
  });
  iecSim.close();

  // ---- S7comm driver against the simulator ----
  console.log('s7comm driver (against simulator)');
  const s7Sim = await startS7Sim({ acceptRack: 0, acceptSlot: 2, refuseWrongSlot: true });
  await test('connect completes COTP + S7 setup at the right rack/slot', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 's7comm', host: '127.0.0.1', port: s7Sim.port });
    const art = await orchestrator.runVerb(ses.id, 'connect', { rack: 0, slot: 2 });
    assert.strictEqual(art.result.cotp_confirmed, true);
    assert.strictEqual(art.result.s7_setup, true);
    assert.strictEqual(art.result.negotiated_pdu, 480);
  });
  await test('identify reads the module order number and firmware from SZL', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 's7comm', host: '127.0.0.1', port: s7Sim.port });
    const art = await orchestrator.runVerb(ses.id, 'identify', { rack: 0, slot: 2 });
    assert.strictEqual(art.result.order_number, '6ES7 315-2EH14-0AB0');
    assert.strictEqual(art.result.firmware, '3.2');
    assert.ok(art.raw.tx && art.raw.rx, 'expected COTP tx/rx hex in raw');
  });
  await test('correct rack/slot diagnoses healthy', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 's7comm', host: '127.0.0.1', port: s7Sim.port });
    const art = await orchestrator.diagnose(ses.id, { rack: 0, slot: 2 });
    assert.strictEqual(art.verdicts[0].rule_id, 'healthy');
  });
  await test('wrong rack/slot produces the COTP-refused verdict', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 's7comm', host: '127.0.0.1', port: s7Sim.port });
    const art = await orchestrator.diagnose(ses.id, { rack: 0, slot: 1, timeout: 1000 });
    // The sim drops the connection on a wrong TSAP; the driver reports COTP not
    // confirmed (or a transport error) — both resolve to an actionable verdict.
    assert.ok(['cotp-refused', 'port-closed'].includes(art.verdicts[0].rule_id));
  });
  s7Sim.server.close();

  // ---- Sparkplug B driver against a broker + edge node ----
  console.log('sparkplug driver (against broker + edge node)');
  await test('protobuf codec round-trips seq and metrics', async () => {
    const { encodePayload, decodePayload } = await import('../src/drivers/sparkplug.js');
    const enc = encodePayload({ seq: 200, timestamp: 5, metrics: [{ name: 'Temperature', alias: 1, datatype: 9, intValue: 72 }] });
    const dec = decodePayload(enc);
    assert.strictEqual(dec.seq, 200);
    assert.strictEqual(dec.metrics.length, 1);
    assert.strictEqual(dec.metrics[0].name, 'Temperature');
    assert.strictEqual(dec.metrics[0].alias, 1);
  });
  const spBroker = await startMqttBroker({});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await test('healthy namespace: birth + contiguous seq diagnoses healthy', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'sparkplug', host: '127.0.0.1', port: spBroker.port });
    const p = orchestrator.diagnose(ses.id, { window_ms: 1200 });
    await sleep(200);
    const node = startSparkplugNode({ brokerPort: spBroker.port, group: 'PlantA', node: 'N1', intervalMs: 80 });
    const art = await p;
    await node.stop();
    assert.strictEqual(art.verdicts[0].rule_id, 'healthy');
  });
  await test('a dropped sequence number produces the sequence-gap verdict', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'sparkplug', host: '127.0.0.1', port: spBroker.port });
    const p = orchestrator.diagnose(ses.id, { window_ms: 1400 });
    await sleep(200);
    const node = startSparkplugNode({ brokerPort: spBroker.port, group: 'PlantB', node: 'N2', intervalMs: 70, gapAfter: 3 });
    const art = await p;
    await node.stop();
    assert.strictEqual(art.verdicts[0].rule_id, 'sequence-gap');
    assert.ok(art.result.facts.sparkplug.total_gaps > 0);
  });
  await test('an NDEATH produces the node-death verdict', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'sparkplug', host: '127.0.0.1', port: spBroker.port });
    const p = orchestrator.diagnose(ses.id, { window_ms: 1400 });
    await sleep(200);
    const node = startSparkplugNode({ brokerPort: spBroker.port, group: 'PlantC', node: 'N3', intervalMs: 70, emitDeathAfter: 4 });
    const art = await p;
    await node.stop();
    assert.strictEqual(art.verdicts[0].rule_id, 'node-death');
  });
  await test('browse renders the node tree with lifecycle state', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'sparkplug', host: '127.0.0.1', port: spBroker.port });
    const p = orchestrator.runVerb(ses.id, 'browse', { window_ms: 1000 });
    await sleep(150);
    const node = startSparkplugNode({ brokerPort: spBroker.port, group: 'PlantD', node: 'N4', intervalMs: 80 });
    const art = await p;
    await node.stop();
    const points = art.result.tree[0].points;
    assert.ok(points.some((pt) => pt.ref === 'PlantD/N4'));
  });
  await spBroker.close();

  // ---- OPC UA driver against the simulator ----
  console.log('opcua driver (against simulator)');
  const uaSim = await startOpcuaSim({});
  await test('connect completes the UACP Hello/Ack handshake', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'opcua', host: '127.0.0.1', port: uaSim.port });
    const art = await orchestrator.runVerb(ses.id, 'connect', {});
    assert.strictEqual(art.result.handshake, 'acknowledged');
    assert.ok(art.raw.tx && art.raw.rx, 'expected tx/rx hex in raw');
  });
  await test('identify surfaces the negotiated transport limits', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'opcua', host: '127.0.0.1', port: uaSim.port });
    const art = await orchestrator.runVerb(ses.id, 'identify', {});
    assert.strictEqual(art.result.acknowledged, true);
    assert.strictEqual(art.result.receive_buffer, 65536);
    assert.strictEqual(art.result.max_chunk_count, 64);
  });
  await test('acknowledged handshake diagnoses healthy', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'opcua', host: '127.0.0.1', port: uaSim.port });
    const art = await orchestrator.diagnose(ses.id);
    assert.strictEqual(art.verdicts[0].rule_id, 'healthy');
  });
  await test('rejected endpoint URL produces the endpoint-url-invalid verdict', async () => {
    const badSim = await startOpcuaSim({ rejectEndpoint: true, errorCode: 0x80830000 });
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'opcua', host: '127.0.0.1', port: badSim.port });
    const art = await orchestrator.diagnose(ses.id, { endpoint_url: 'opc.tcp://wrong-host/UA' });
    assert.strictEqual(art.verdicts[0].rule_id, 'endpoint-url-invalid');
    assert.strictEqual(art.verdicts[0].severity, 'error');
    badSim.server.close();
  });
  uaSim.server.close();

  // ---- IP Scanner (TCP host/port discovery) ----
  console.log('ip scanner (discovery)');
  // Two ad-hoc TCP services on ephemeral ports: one open, plus a known-closed one.
  const svcA = net.createServer((s) => s.on('error', () => {}));
  const svcB = net.createServer((s) => s.on('error', () => {}));
  await new Promise((r) => svcA.listen(0, '127.0.0.1', r));
  await new Promise((r) => svcB.listen(0, '127.0.0.1', r));
  const pA = svcA.address().port;
  const pB = svcB.address().port;
  await test('connect reports an open port', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'ipscan', host: '127.0.0.1' });
    const art = await orchestrator.runVerb(ses.id, 'connect', { port: pA, timeout: 800 });
    assert.strictEqual(art.result.state, 'open');
  });
  await test('browse scans a range and finds the open ports', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'ipscan', host: '127.0.0.1' });
    const lo = Math.min(pA, pB);
    const hi = Math.max(pA, pB);
    const art = await orchestrator.runVerb(ses.id, 'browse', { start: lo, end: hi, timeout: 300 });
    const refs = art.result.tree[0].points.map((p) => p.ref);
    assert.ok(refs.includes(`${pA}/tcp`) && refs.includes(`${pB}/tcp`));
  });
  await test('a refused port reads as closed and host as up', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'ipscan', host: '127.0.0.1' });
    // Bind then immediately close so the port is refused (host still up).
    const tmp = net.createServer();
    const closedPort = await new Promise((r) => tmp.listen(0, '127.0.0.1', () => { const p = tmp.address().port; tmp.close(() => r(p)); }));
    const art = await orchestrator.runVerb(ses.id, 'connect', { port: closedPort, timeout: 800 });
    assert.strictEqual(art.result.state, 'closed');
  });
  await test('CIDR sweep finds the loopback host up', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'ipscan', host: '127.0.0.1' });
    const art = await orchestrator.runVerb(ses.id, 'read', { cidr: '127.0.0.1/32', port: pA, timeout: 500 });
    assert.strictEqual(art.result.hosts_up, 1);
  });
  svcA.close();
  svcB.close();

  // ---- DHCP / BOOTP ----
  console.log('dhcp / bootp (discovery)');
  const dhcpSim = await startDhcpSim({});
  await test('identify decodes a DHCP OFFER (ip, subnet, router, lease)', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'dhcp', host: '127.0.0.1' });
    const art = await orchestrator.runVerb(ses.id, 'identify', { server: '127.0.0.1', server_port: dhcpSim.port, client_port: 0, window_ms: 900 });
    assert.strictEqual(art.result.first_offer.your_ip, '10.10.0.50');
    assert.strictEqual(art.result.first_offer.options.subnet_mask, '255.255.255.0');
    assert.strictEqual(art.result.first_offer.options.lease_seconds, 86400);
  });
  await test('single server diagnoses healthy', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'dhcp', host: '127.0.0.1' });
    const art = await orchestrator.diagnose(ses.id, { server: '127.0.0.1', server_port: dhcpSim.port, client_port: 0, window_ms: 900 });
    assert.strictEqual(art.verdicts[0].rule_id, 'healthy');
  });
  await test('two servers answering produces the rogue-server verdict', async () => {
    const rogueSim = await startDhcpSim({
      offers: [
        { yourIp: '10.10.0.50', serverId: '10.10.0.1', subnet: '255.255.255.0', router: '10.10.0.1', dns: '10.10.0.1', lease: 86400 },
        { yourIp: '192.168.1.77', serverId: '192.168.1.1', subnet: '255.255.255.0', router: '192.168.1.1', dns: '8.8.8.8', lease: 600 },
      ],
    });
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'dhcp', host: '127.0.0.1' });
    const art = await orchestrator.diagnose(ses.id, { server: '127.0.0.1', server_port: rogueSim.port, client_port: 0, window_ms: 1000 });
    assert.strictEqual(art.verdicts[0].rule_id, 'rogue-server');
    assert.strictEqual(art.verdicts[0].severity, 'error');
    rogueSim.close();
  });
  await test('assign runs DISCOVER→REQUEST→ACK and reads back the leased IP (double-gate)', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'dhcp', host: '127.0.0.1' });
    orchestrator.arm(ses.id, 'ARM');
    const wp = { mac: 'aa:bb:cc:11:22:33', requested_ip: '10.10.0.50', server: '127.0.0.1', server_port: dhcpSim.port, client_port: 0, window_ms: 900 };
    const prep = await orchestrator.prepareWrite(ses.id, wp);
    assert.strictEqual(prep.proposed_value, '10.10.0.50');
    const art = await orchestrator.confirmWrite(ses.id, prep.token);
    assert.strictEqual(art.result.ack, true);
    assert.strictEqual(art.result.read_back, '10.10.0.50');
    assert.strictEqual(art.result.verified, true);
    assert.strictEqual(art.result.mac, 'aa:bb:cc:11:22:33');
  });
  await test('classic BOOTP assigns a MAC its address in one request/reply', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'dhcp', host: '127.0.0.1' });
    orchestrator.arm(ses.id, 'ARM');
    const wp = { mode: 'bootp', mac: 'de:ad:be:ef:00:01', server: '127.0.0.1', server_port: dhcpSim.port, client_port: 0, window_ms: 900 };
    const prep = await orchestrator.prepareWrite(ses.id, wp);
    const art = await orchestrator.confirmWrite(ses.id, prep.token);
    assert.strictEqual(art.result.mode, 'bootp');
    assert.strictEqual(art.result.ack, true); // BOOTREPLY
    assert.strictEqual(art.result.read_back, '10.10.0.50');
    assert.strictEqual(art.result.lease_seconds, null); // BOOTP has no lease
  });
  dhcpSim.close();

  // ---- PROFINET DCP / LLDP ----
  console.log('profinet-dcp (discovery)');
  const dcpSim = await startProfinetDcpSim({});
  await test('identify decodes device station name / IP / vendor / role', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'profinet-dcp', host: '127.0.0.1' });
    const art = await orchestrator.runVerb(ses.id, 'identify', { responder: '127.0.0.1', responder_port: dcpSim.port, window_ms: 900 });
    assert.strictEqual(art.result.devices, 3);
    const plc = art.decode.find((d) => d.name_of_station === 'plc-line3');
    assert.strictEqual(plc.ip, '192.168.0.10');
    assert.strictEqual(plc.role, 'IO-Controller');
  });
  await test('healthy segment diagnoses devices-found', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'profinet-dcp', host: '127.0.0.1' });
    const art = await orchestrator.diagnose(ses.id, { responder: '127.0.0.1', responder_port: dcpSim.port, window_ms: 900 });
    assert.strictEqual(art.verdicts[0].rule_id, 'devices-found');
  });
  await test('duplicate station name produces the error verdict', async () => {
    const dupSim = await startProfinetDcpSim({
      devices: [
        { name: 'io-station-1', ip: '192.168.0.20', vendor: 'Siemens, ET200SP', role: 0x01 },
        { name: 'io-station-1', ip: '192.168.0.21', vendor: 'Siemens, ET200SP', role: 0x01 },
      ],
    });
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'profinet-dcp', host: '127.0.0.1' });
    const art = await orchestrator.diagnose(ses.id, { responder: '127.0.0.1', responder_port: dupSim.port, window_ms: 900 });
    assert.strictEqual(art.verdicts[0].rule_id, 'duplicate-name');
    assert.strictEqual(art.verdicts[0].severity, 'error');
    dupSim.close();
  });
  await test('unconfigured IP (0.0.0.0) produces the commissioning verdict', async () => {
    const newSim = await startProfinetDcpSim({
      devices: [{ name: 'fresh-device', ip: '0.0.0.0', vendor: 'Siemens, ET200SP', role: 0x01 }],
    });
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'profinet-dcp', host: '127.0.0.1' });
    const art = await orchestrator.diagnose(ses.id, { responder: '127.0.0.1', responder_port: newSim.port, window_ms: 900 });
    assert.strictEqual(art.verdicts[0].rule_id, 'unconfigured-ip');
    newSim.close();
  });
  await test('browse builds a physical port topology from LLDP (which port cables to what)', async () => {
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'profinet-dcp', host: '127.0.0.1' });
    const art = await orchestrator.runVerb(ses.id, 'browse', { responder: '127.0.0.1', responder_port: dcpSim.port, window_ms: 900 });
    const t = art.result.topology;
    assert.strictEqual(t.kind, 'physical');
    // The PLC's X1 P2 carries a device, exposed as a linked port on the node.
    const plc = t.nodes.find((n) => n.label === 'plc-line3');
    assert.strictEqual(plc.kind, 'controller');
    assert.ok(plc.ports.some((p) => p.name === 'X1 P2' && p.linked));
    // The line PLC—dev1—dev2 collapses to two deduped port-to-port cables.
    assert.strictEqual(t.links.length, 2);
    const cable = t.links.find((l) => [l.a.station, l.b.station].sort().join() === ['io-station-1', 'plc-line3'].sort().join());
    assert.ok(cable, 'expected a plc-line3 ↔ io-station-1 cable');
    const ports = [cable.a.port, cable.b.port].sort();
    assert.deepStrictEqual(ports, ['X1 P1', 'X1 P2']);
  });
  await test('logical fallback when no LLDP neighbours are present', async () => {
    const flatSim = await startProfinetDcpSim({
      devices: [{ name: 'lonely-dev', ip: '10.0.0.5', subnet: '255.255.255.0', vendor: 'Acme', role: 0x01 }], // no ports
    });
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'profinet-dcp', host: '127.0.0.1' });
    const art = await orchestrator.runVerb(ses.id, 'browse', { responder: '127.0.0.1', responder_port: flatSim.port, window_ms: 700 });
    assert.strictEqual(art.result.topology.kind, 'logical');
    assert.ok(art.result.topology.nodes.some((n) => n.kind === 'segment'));
    flatSim.close();
  });
  await test('DCP Set assigns IP / subnet / gateway (through the double-gate, with read-back)', async () => {
    const cfgSim = await startProfinetDcpSim({
      devices: [{ name: 'fresh-device', ip: '0.0.0.0', subnet: '0.0.0.0', gateway: '0.0.0.0', vendor: 'Siemens, ET200SP', role: 0x01 }],
    });
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'profinet-dcp', host: '127.0.0.1' });
    orchestrator.arm(ses.id, 'ARM');
    const wp = { operation: 'set-ip', target: 'fresh-device', ip: '192.168.10.5', subnet: '255.255.255.0', gateway: '192.168.10.1', responder: '127.0.0.1', responder_port: cfgSim.port, window_ms: 900 };
    const prep = await orchestrator.prepareWrite(ses.id, wp);
    assert.strictEqual(prep.current_value, '(unconfigured)');
    const art = await orchestrator.confirmWrite(ses.id, prep.token);
    assert.strictEqual(art.result.ack, true);
    assert.strictEqual(art.result.read_back, '192.168.10.5');
    assert.strictEqual(art.result.verified, true);
    cfgSim.close();
  });
  await test('DCP Set renames a station (NameOfStation)', async () => {
    const cfgSim = await startProfinetDcpSim({
      devices: [{ name: 'old-name', ip: '192.168.0.30', subnet: '255.255.255.0', gateway: '192.168.0.1', vendor: 'Siemens, ET200SP', role: 0x01 }],
    });
    const { orchestrator } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'profinet-dcp', host: '127.0.0.1' });
    const ctx = { host: '127.0.0.1', armed: true, params: { operation: 'set-name', target: 'old-name', new_name: 'press-42', responder: '127.0.0.1', responder_port: cfgSim.port, window_ms: 900 } };
    const out = await profinetDcp.verbs.write(ctx);
    assert.strictEqual(out.artifact.result.ack, true);
    assert.strictEqual(out.artifact.result.read_back, 'press-42');
    assert.strictEqual(out.artifact.result.verified, true);
    cfgSim.close();
  });
  await test('DCP Set refuses to compose a frame when not ARMED', async () => {
    await assert.rejects(
      () => profinetDcp.verbs.write({ host: '127.0.0.1', armed: false, params: { operation: 'set-name', target: 'x', new_name: 'y' } }),
      /not ARMED/,
    );
  });
  dcpSim.close();

  // ---- commissioning report (§12 phase 8) ----
  console.log('commissioning report');
  await test('report renders findings, timeline, and audit with redaction', async () => {
    const { renderSessionReport, redact } = await import('../src/report/report.js');
    const { orchestrator, store } = makeStack();
    const ses = orchestrator.openSession({ driverId: 'modbus-tcp', host: '127.0.0.1', port: sim.port, unitId: 1 });
    await orchestrator.diagnose(ses.id);
    orchestrator.arm(ses.id, 'ARM');
    const prep = await orchestrator.prepareWrite(ses.id, { area: 'holding', address: 3, value: 77 });
    await orchestrator.confirmWrite(ses.id, prep.token);
    const html = renderSessionReport({
      session: store.getSession(ses.id),
      artifacts: store.listArtifacts(ses.id),
      audit: store.listAudit(),
    });
    assert.match(html, /Fieldscope commissioning report/);
    assert.match(html, /Modbus responding normally/); // verdict made it in
    assert.match(html, /modbus-write/); // audit trail made it in
    // credential redaction
    const red = redact({ params: { community: 'private', password: 'hunter2', address: 3 } });
    assert.strictEqual(red.params.community, '•••redacted•••');
    assert.strictEqual(red.params.password, '•••redacted•••');
    assert.strictEqual(red.params.address, 3);
    assert.ok(!html.includes('hunter2'));
  });

  sim.server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
