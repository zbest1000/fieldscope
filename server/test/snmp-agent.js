// Minimal SNMP v2c agent for tests and the sim lab, built on net-snmp's agent.
// Serves the system group plus an ifTable with configurable error counters so
// the flaky-cable verdict can be exercised end-to-end.

import snmp from 'net-snmp';

export async function startSnmpAgent({
  port = 0,
  community = 'public',
  sysName = 'fieldscope-sim-switch',
  sysDescr = 'Fieldscope simulated managed switch',
  // Each entry: [index, descr, speedBps, adminStatus, operStatus, inDiscards, inErrors, outDiscards, outErrors]
  interfaces = [
    [1, 'eth0 uplink', 1_000_000_000, 1, 1, 0, 0, 0, 0],
    [2, 'eth1 plc', 100_000_000, 1, 1, 0, 0, 0, 0],
  ],
} = {}) {
  // net-snmp maps port 0 to the default 161, so "pick a free one" is done here:
  // choose a random high port (retrying is unnecessary at these odds for tests).
  const boundPort = port || 20000 + Math.floor(Math.random() * 20000);
  const agent = snmp.createAgent({ port: boundPort, address: '127.0.0.1', disableAuthorization: false }, (error) => {
    // Per-request callback; errors here are per-PDU, not fatal.
    if (error && error.message && !/RequestFailed/.test(error.name || '')) {
      // Keep the sim quiet in tests; uncomment to debug: console.error(error);
    }
  });
  agent.getAuthorizer().addCommunity(community);
  const mib = agent.getMib();

  const scalar = (name, oid, scalarType, value) => {
    mib.registerProvider({
      name,
      type: snmp.MibProviderType.Scalar,
      oid,
      scalarType,
      maxAccess: snmp.MaxAccess['read-only'],
    });
    mib.setScalarValue(name, value);
  };

  scalar('sysDescr', '1.3.6.1.2.1.1.1', snmp.ObjectType.OctetString, sysDescr);
  scalar('sysObjectID', '1.3.6.1.2.1.1.2', snmp.ObjectType.OID, '1.3.6.1.4.1.99999.1');
  scalar('sysUpTime', '1.3.6.1.2.1.1.3', snmp.ObjectType.TimeTicks, 4242000);
  scalar('sysContact', '1.3.6.1.2.1.1.4', snmp.ObjectType.OctetString, 'fieldscope');
  scalar('sysName', '1.3.6.1.2.1.1.5', snmp.ObjectType.OctetString, sysName);
  scalar('sysLocation', '1.3.6.1.2.1.1.6', snmp.ObjectType.OctetString, 'sim lab');

  mib.registerProvider({
    name: 'ifTable',
    type: snmp.MibProviderType.Table,
    oid: '1.3.6.1.2.1.2.2.1',
    maxAccess: snmp.MaxAccess['not-accessible'],
    tableColumns: [
      { number: 1, name: 'ifIndex', type: snmp.ObjectType.Integer, maxAccess: snmp.MaxAccess['read-only'] },
      { number: 2, name: 'ifDescr', type: snmp.ObjectType.OctetString, maxAccess: snmp.MaxAccess['read-only'] },
      { number: 5, name: 'ifSpeed', type: snmp.ObjectType.Gauge, maxAccess: snmp.MaxAccess['read-only'] },
      { number: 7, name: 'ifAdminStatus', type: snmp.ObjectType.Integer, maxAccess: snmp.MaxAccess['read-only'] },
      { number: 8, name: 'ifOperStatus', type: snmp.ObjectType.Integer, maxAccess: snmp.MaxAccess['read-only'] },
      { number: 13, name: 'ifInDiscards', type: snmp.ObjectType.Counter, maxAccess: snmp.MaxAccess['read-only'] },
      { number: 14, name: 'ifInErrors', type: snmp.ObjectType.Counter, maxAccess: snmp.MaxAccess['read-only'] },
      { number: 19, name: 'ifOutDiscards', type: snmp.ObjectType.Counter, maxAccess: snmp.MaxAccess['read-only'] },
      { number: 20, name: 'ifOutErrors', type: snmp.ObjectType.Counter, maxAccess: snmp.MaxAccess['read-only'] },
    ],
    tableIndex: [{ columnName: 'ifIndex' }],
  });
  for (const row of interfaces) mib.addTableRow('ifTable', row);

  // The listener binds its dgram socket lazily; wait until it is actually up
  // so callers can query immediately.
  const deadline = Date.now() + 2000;
  while (Object.keys(agent.listener.sockets || {}).length === 0) {
    if (Date.now() > deadline) throw new Error('snmp agent failed to bind');
    await new Promise((r) => setTimeout(r, 20));
  }

  return {
    agent,
    port: boundPort,
    close: () => agent.close(),
  };
}
