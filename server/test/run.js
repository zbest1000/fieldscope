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

  sim.server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
