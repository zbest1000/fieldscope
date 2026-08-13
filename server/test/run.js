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
