// SNMP v1/v2c driver (§6.1). The spec calls out per-port error/discard/CRC
// counters as THE flaky-cable detector — that is this driver's diagnose story:
// walk ifTable, find interfaces that are up but accumulating errors, and say so
// in plain English. Identify reads the system group; read returns the interface
// table with counters.
//
// Note: an SNMP agent silently drops requests with a wrong community string, so
// "timeout" and "wrong community" are indistinguishable on the wire — the
// verdict says exactly that.

import snmp from 'net-snmp';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'snmp',
  display_name: 'SNMP v1/v2c',
  domain: 'it',
  group: 'tools',
  transport: ['udp'],
  default_port: 161,
  mode: 'full',
  lib: '🟢 net-snmp',
  describe:
    'System identity, per-port error/discard counters (the flaky-cable detector), uptime monitor.',
  verbs: ['identify', 'read', 'monitor', 'diagnose'],
  params: {
    identify: { community: { type: 'string', default: 'public' } },
    read: { community: { type: 'string', default: 'public' } },
    monitor: { community: { type: 'string', default: 'public' } },
    diagnose: { community: { type: 'string', default: 'public' } },
  },
};

const SYSTEM_OIDS = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  sysLocation: '1.3.6.1.2.1.1.6.0',
};

const IF_TABLE_OID = '1.3.6.1.2.1.2.2';
// ifEntry column numbers we surface.
const IF_COLS = {
  1: 'index',
  2: 'descr',
  5: 'speed',
  7: 'admin_status',
  8: 'oper_status',
  13: 'in_discards',
  14: 'in_errors',
  19: 'out_discards',
  20: 'out_errors',
};
const IF_STATUS = { 1: 'up', 2: 'down', 3: 'testing' };

function makeSession(ctx) {
  const version = ctx.params?.version === 'v1' ? snmp.Version1 : snmp.Version2c;
  return snmp.createSession(ctx.host, ctx.params?.community || 'public', {
    port: ctx.port || 161,
    version,
    timeout: ctx.params?.timeout ?? 2000,
    retries: 0,
  });
}

function vbString(vb) {
  if (vb == null || snmp.isVarbindError(vb)) return null;
  return Buffer.isBuffer(vb.value) ? vb.value.toString('utf8') : String(vb.value);
}

function snmpGet(ctx, oids) {
  const session = makeSession(ctx);
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    session.get(oids, (error, varbinds) => {
      const rttMs = Number(process.hrtime.bigint() - started) / 1e6;
      session.close();
      resolve({ error, varbinds, rttMs });
    });
  });
}

function snmpTable(ctx, oid) {
  const session = makeSession(ctx);
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    session.table(oid, 20, (error, table) => {
      const rttMs = Number(process.hrtime.bigint() - started) / 1e6;
      session.close();
      resolve({ error, table, rttMs });
    });
  });
}

function isTimeout(error) {
  return error && /timed?\s*out|timeout/i.test(error.message || String(error));
}

function ticksToDays(ticks) {
  return ticks == null ? null : Math.round((Number(ticks) / 8640000) * 10) / 10;
}

async function readSystem(ctx) {
  const oids = Object.values(SYSTEM_OIDS);
  const { error, varbinds, rttMs } = await snmpGet(ctx, oids);
  if (error) return { error, timeout: isTimeout(error), rttMs };
  const [descr, objectId, upTime, name, location] = varbinds;
  return {
    rttMs,
    system: {
      descr: vbString(descr),
      object_id: vbString(objectId),
      uptime_ticks: upTime && !snmp.isVarbindError(upTime) ? Number(upTime.value) : null,
      uptime_days: upTime && !snmp.isVarbindError(upTime) ? ticksToDays(upTime.value) : null,
      name: vbString(name),
      location: vbString(location),
    },
  };
}

async function readInterfaces(ctx) {
  const { error, table, rttMs } = await snmpTable(ctx, IF_TABLE_OID);
  if (error) return { error, timeout: isTimeout(error), rttMs };
  const interfaces = Object.entries(table || {}).map(([index, row]) => {
    const iface = { index: Number(index) };
    for (const [col, name] of Object.entries(IF_COLS)) {
      const v = row[col];
      if (v === undefined) continue;
      iface[name] = Buffer.isBuffer(v) ? v.toString('utf8') : Number(v);
    }
    iface.admin_status_text = IF_STATUS[iface.admin_status] || String(iface.admin_status ?? '?');
    iface.oper_status_text = IF_STATUS[iface.oper_status] || String(iface.oper_status ?? '?');
    iface.errors_total =
      (iface.in_errors || 0) + (iface.out_errors || 0) + (iface.in_discards || 0) + (iface.out_discards || 0);
    return iface;
  });
  return { interfaces, rttMs };
}

// Facts for the snmp rulepack: reachability + the error-counter picture.
function interfaceFacts(interfaces) {
  const up = interfaces.filter((i) => i.oper_status === 1);
  const withErrors = interfaces.filter((i) => i.oper_status === 1 && i.errors_total > 0);
  const worst = withErrors.sort((a, b) => b.errors_total - a.errors_total)[0] || null;
  return {
    count: interfaces.length,
    up: up.length,
    with_errors: withErrors.length,
    max_errors: worst ? worst.errors_total : 0,
    worst: worst ? `${worst.descr || `if${worst.index}`} (${worst.errors_total} errors/discards)` : null,
  };
}

export const verbs = {
  async identify(ctx) {
    const r = await readSystem(ctx);
    if (r.error) {
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: `GET system group → ${r.error.message || r.error}`,
          result: { reachable: false, timeout: r.timeout, error: String(r.error.message || r.error) },
          error: r.error,
        }),
        facts: { transport: { snmp_response: 'none' }, timeout: r.timeout },
      };
    }
    return {
      artifact: makeArtifact({
        verb: 'identify',
        raw: `GET sysDescr/sysObjectID/sysUpTime/sysName/sysLocation in ${r.rttMs.toFixed(1)}ms`,
        result: { reachable: true, ...r.system, rtt_ms: r.rttMs },
      }),
      facts: { transport: { snmp_response: 'success' }, system: r.system, timeout: false },
    };
  },

  // Read = the interface table with counters, rendered as a point tree.
  async read(ctx) {
    const r = await readInterfaces(ctx);
    if (r.error) {
      return {
        artifact: makeArtifact({
          verb: 'read',
          raw: `walk ifTable → ${r.error.message || r.error}`,
          result: { reachable: false, timeout: r.timeout },
          error: r.error,
        }),
        facts: { transport: { snmp_response: 'none' }, timeout: r.timeout },
      };
    }
    const tree = [
      {
        area: `ifTable (${r.interfaces.length} interfaces)`,
        points: r.interfaces.map((i) => ({
          ref: i.descr || `if${i.index}`,
          value: `${i.oper_status_text}/${i.admin_status_text} · err ${i.in_errors || 0}/${i.out_errors || 0} · disc ${i.in_discards || 0}/${i.out_discards || 0}`,
          type: i.speed ? `${Math.round(i.speed / 1e6)}Mb` : '',
        })),
      },
    ];
    return {
      artifact: makeArtifact({
        verb: 'read',
        raw: `walk ifTable → ${r.interfaces.length} interfaces in ${r.rttMs.toFixed(1)}ms`,
        result: { tree, interfaces: r.interfaces, rtt_ms: r.rttMs },
      }),
      facts: {
        transport: { snmp_response: 'success' },
        interfaces: interfaceFacts(r.interfaces),
        timeout: false,
      },
    };
  },

  // Monitor = agent responsiveness via sysUpTime polls; a reboot shows up as an
  // uptime reset in the series.
  async monitorSample(ctx) {
    const { error, varbinds, rttMs } = await snmpGet(ctx, [SYSTEM_OIDS.sysUpTime]);
    if (error) return { value: null, ok: false, raw: `sysUpTime → ${error.message || error}` };
    const ticks = varbinds[0] && !snmp.isVarbindError(varbinds[0]) ? Number(varbinds[0].value) : null;
    return {
      value: rttMs,
      ok: true,
      series: { uptime_days: ticksToDays(ticks) },
      raw: `sysUpTime=${ticks} in ${rttMs.toFixed(1)}ms`,
    };
  },

  async diagnose(ctx) {
    const sys = await readSystem(ctx);
    if (sys.error) {
      return {
        facts: { transport: { snmp_response: 'none' }, timeout: sys.timeout },
        rulepack: 'snmp',
        raw: `GET system group → ${sys.error.message || sys.error}`,
      };
    }
    const ifs = await readInterfaces(ctx);
    const facts = {
      transport: { snmp_response: 'success' },
      system: sys.system,
      interfaces: ifs.error ? { count: 0 } : interfaceFacts(ifs.interfaces),
      timeout: false,
      rtt_ms: sys.rttMs,
    };
    return {
      facts,
      rulepack: 'snmp',
      raw: [
        `sysName=${sys.system.name} uptime=${sys.system.uptime_days}d`,
        ifs.error
          ? `ifTable: ${ifs.error.message || ifs.error}`
          : `ifTable: ${facts.interfaces.count} interfaces, ${facts.interfaces.with_errors} with errors (worst: ${facts.interfaces.worst || 'none'})`,
      ].join('\n'),
      decode: ifs.interfaces || null,
    };
  },
};
