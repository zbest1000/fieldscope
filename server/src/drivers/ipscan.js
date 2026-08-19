// IP Scanner (§7 Discovery, §6.1). A TCP host/port discovery driver built on the
// bounded TCP transport: host discovery across a CIDR, port scanning (curated
// common ports or an explicit range), and service identification by well-known
// port plus a light banner grab. Everything is concurrency-pooled and bounded
// (scans on a live OT segment must never be unbounded — §2).
//
// Verbs:
//   connect  — single-port state check (open / closed / filtered)
//   identify — scan a curated common-port list, name services, grab banners
//   browse   — scan a port range, list open ports
//   read     — sweep a CIDR for live hosts (TCP-ping)
//   monitor  — watch a single port's reachability over time
//   diagnose — verdict over the common-port scan (exposed OT / remote access …)

import net from 'node:net';
import { tcpConnect } from '../transport/transport.js';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'ipscan',
  display_name: 'IP Scanner',
  domain: 'it',
  group: 'discovery',
  transport: ['tcp'],
  default_port: null,
  mode: 'full',
  lib: '🟢 raw sockets',
  describe: 'TCP host discovery, port scan, and service identification. Bounded and rate-limited.',
  verbs: ['connect', 'identify', 'browse', 'read', 'monitor', 'diagnose'],
  params: {
    connect: { port: { type: 'number', default: 80, min: 1, max: 65535 } },
    identify: { timeout: { type: 'number', default: 500, min: 100, max: 5000 }, banners: { type: 'enum', options: ['on', 'off'], default: 'on' } },
    browse: {
      start: { type: 'number', default: 1, min: 1, max: 65535 },
      end: { type: 'number', default: 1024, min: 1, max: 65535 },
      timeout: { type: 'number', default: 350, min: 50, max: 5000 },
    },
    read: {
      cidr: { type: 'string', default: '127.0.0.1/30' },
      port: { type: 'number', default: 80, min: 1, max: 65535 },
      timeout: { type: 'number', default: 400, min: 50, max: 5000 },
    },
    monitor: { port: { type: 'number', default: 502, min: 1, max: 65535 } },
    diagnose: { timeout: { type: 'number', default: 500, min: 100, max: 5000 } },
  },
};

// Well-known ports → service. Heavy on the OT/ICS side — that is the point.
const SERVICES = {
  21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'dns', 67: 'dhcp', 69: 'tftp', 80: 'http',
  102: 's7 / iso-tsap', 110: 'pop3', 123: 'ntp', 135: 'msrpc', 139: 'netbios', 143: 'imap',
  161: 'snmp', 179: 'bgp', 389: 'ldap', 443: 'https', 445: 'smb', 502: 'modbus', 515: 'lpd',
  623: 'ipmi', 771: 'realport', 789: 'redlion-crimson', 1089: 'ff-annunc', 1091: 'ff-sm',
  1911: 'niagara-fox', 1962: 'pcworx', 2000: 'cisco-sccp', 2222: 'ethernet/ip (i/o)', 2404: 'iec-104',
  3389: 'rdp', 4000: 'emerson-roc', 4840: 'opc-ua', 4911: 'niagara-foxs', 5006: 'melsec', 5007: 'melsec',
  5432: 'postgres', 5900: 'vnc', 5901: 'vnc', 5920: 'codesys', 6000: 'x11', 8000: 'http-alt',
  8080: 'http-proxy', 8443: 'https-alt', 9600: 'omron-fins', 18245: 'ge-srtp', 18246: 'ge-srtp',
  20000: 'dnp3', 20547: 'proconos', 34962: 'profinet-rt', 34964: 'profinet-cm', 44818: 'ethernet/ip',
  47808: 'bacnet', 55000: 'foundation-fieldbus', 1883: 'mqtt', 8883: 'mqtt-tls', 5683: 'coap',
};
const COMMON_PORTS = Object.keys(SERVICES).map(Number).sort((a, b) => a - b);
// Ports that mean "someone can log in interactively" if exposed.
const REMOTE_ACCESS = new Set([22, 23, 3389, 5900, 5901, 5920]);
// Industrial control services worth flagging when reachable.
const OT_PORTS = new Set([102, 502, 2222, 2404, 4840, 5006, 5007, 9600, 18245, 20000, 34962, 34964, 44818, 47808, 1911, 1962, 20547, 789]);

const MAX_HOSTS = 1024; // hard cap on a CIDR sweep
const CONCURRENCY = 64;

// Bounded async pool — runs `worker` over `items` with at most `n` in flight.
async function pool(items, worker, n = CONCURRENCY) {
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

// Grab up to the first chunk a service volunteers (FTP/SSH/SMTP greet; most OT
// protocols stay silent, which is itself a signal). Never sends anything.
function grabBanner(socket, ms = 350) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => finish(null), ms);
    socket.once('data', (d) => finish(d.toString('latin1').replace(/[^\x20-\x7e]/g, '.').trim().slice(0, 60)));
    socket.once('error', () => finish(null));
  });
}

async function checkPort(host, port, timeout, withBanner = false) {
  try {
    const { socket, connectMs } = await tcpConnect(host, port, timeout);
    // A scanned peer may RST when we drop the connection; swallow late errors so
    // a reset never becomes an unhandled 'error' event.
    socket.on('error', () => {});
    let banner = null;
    if (withBanner) banner = await grabBanner(socket, Math.min(400, timeout));
    socket.destroy();
    return { port, open: true, state: 'open', ms: Math.round(connectMs * 10) / 10, service: SERVICES[port] || null, banner: banner || null };
  } catch (err) {
    const state = err.code === 'ECONNREFUSED' ? 'closed' : err.code === 'ETIMEDOUT' ? 'filtered' : 'error';
    return { port, open: false, state, error: err.code };
  }
}

// ---- CIDR helpers ----------------------------------------------------------
function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) throw new Error(`bad IP ${ip}`);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
function cidrHosts(cidr) {
  const [ip, bitsRaw] = cidr.trim().split('/');
  const bits = bitsRaw == null ? 32 : parseInt(bitsRaw, 10);
  if (bits < 0 || bits > 32) throw new Error(`bad CIDR /${bitsRaw}`);
  const base = bits === 0 ? 0 : (ipToInt(ip) & ((~0 << (32 - bits)) >>> 0)) >>> 0;
  const total = 2 ** (32 - bits);
  const hosts = [];
  // Skip network/broadcast for /31-and-larger blocks; scan all for /31,/32.
  const start = total > 2 ? base + 1 : base;
  const end = total > 2 ? base + total - 1 : base + total;
  for (let a = start; a < end && hosts.length < MAX_HOSTS; a++) hosts.push(intToIp(a >>> 0));
  return { hosts, capped: end - start > MAX_HOSTS };
}

function openSummary(open) {
  return {
    open_count: open.length,
    services: open.map((o) => o.service).filter(Boolean),
    ot_open: open.filter((o) => OT_PORTS.has(o.port)).map((o) => `${o.port} (${o.service})`),
    remote_open: open.filter((o) => REMOTE_ACCESS.has(o.port)).map((o) => `${o.port} (${o.service})`),
  };
}

function portsToTree(area, ports) {
  return {
    tree: [
      {
        area,
        points: ports.map((p) => ({
          ref: `${p.port}/tcp`,
          value: p.banner || p.service || 'open',
          type: `${p.service || '—'}${p.ms != null ? ` · ${p.ms}ms` : ''}`,
        })),
      },
    ],
  };
}

export const verbs = {
  async connect(ctx) {
    const port = ctx.params?.port ?? 80;
    const r = await checkPort(ctx.host, port, ctx.params?.timeout ?? 1500, false);
    return {
      artifact: makeArtifact({
        verb: 'connect',
        raw: `TCP ${ctx.host}:${port} → ${r.state}${r.service ? ` (${r.service})` : ''}`,
        result: { port, state: r.state, open: r.open, service: r.service, rtt_ms: r.ms ?? null },
      }),
      facts: { host: { up: r.open || r.state === 'closed' }, port: { state: r.state } },
    };
  },

  // Curated common-port scan with service names + banners.
  async identify(ctx) {
    const timeout = ctx.params?.timeout ?? 500;
    const withBanner = (ctx.params?.banners ?? 'on') === 'on';
    const scanned = await pool(COMMON_PORTS, (p) => checkPort(ctx.host, p, timeout, withBanner));
    const open = scanned.filter((r) => r.open).sort((a, b) => a.port - b.port);
    const s = openSummary(open);
    return {
      artifact: makeArtifact({
        verb: 'identify',
        raw: `scanned ${COMMON_PORTS.length} common ports on ${ctx.host} → ${open.length} open`,
        result: { host: ctx.host, ...portsToTree(`${open.length} open of ${COMMON_PORTS.length} common ports`, open), ...s },
      }),
      facts: { host: { up: open.length > 0 || scanned.some((r) => r.state === 'closed') }, scan: s },
    };
  },

  // Full range scan (bounded by start/end).
  async browse(ctx) {
    const start = Math.max(1, ctx.params?.start ?? 1);
    const end = Math.min(65535, ctx.params?.end ?? 1024);
    const timeout = ctx.params?.timeout ?? 350;
    const ports = [];
    for (let p = start; p <= end; p++) ports.push(p);
    const scanned = await pool(ports, (p) => checkPort(ctx.host, p, timeout, false));
    const open = scanned.filter((r) => r.open).sort((a, b) => a.port - b.port);
    return {
      artifact: makeArtifact({
        verb: 'browse',
        raw: `scanned ${ports.length} ports (${start}-${end}) on ${ctx.host} → ${open.length} open`,
        result: { host: ctx.host, range: `${start}-${end}`, ...portsToTree(`open ports ${start}-${end}`, open) },
      }),
      facts: {},
    };
  },

  // CIDR host sweep (TCP-ping): refused OR open both prove a host is up.
  async read(ctx) {
    const cidr = ctx.params?.cidr || '127.0.0.1/30';
    const port = ctx.params?.port ?? 80;
    const timeout = ctx.params?.timeout ?? 400;
    let hosts, capped;
    try {
      ({ hosts, capped } = cidrHosts(cidr));
    } catch (err) {
      return {
        artifact: makeArtifact({ verb: 'read', raw: `error: ${err.message}`, result: { error: err.message }, error: err }),
        facts: {},
      };
    }
    const swept = await pool(
      hosts,
      async (h) => {
        const r = await checkPort(h, port, timeout, false);
        return { host: h, up: r.open || r.state === 'closed', how: r.open ? 'open' : r.state };
      },
      Math.min(128, CONCURRENCY),
    );
    const up = swept.filter((h) => h.up);
    return {
      artifact: makeArtifact({
        verb: 'read',
        raw: `swept ${hosts.length}${capped ? '+ (capped)' : ''} hosts in ${cidr} on :${port} → ${up.length} up`,
        result: {
          cidr,
          probe_port: port,
          hosts_up: up.length,
          hosts_total: hosts.length,
          capped: !!capped,
          tree: [{ area: `${up.length} hosts up in ${cidr}`, points: up.map((h) => ({ ref: h.host, value: h.how, type: `:${port}` })) }],
        },
      }),
      facts: { sweep: { up: up.length, total: hosts.length } },
    };
  },

  async monitorSample(ctx) {
    const port = ctx.params?.port ?? 502;
    const r = await checkPort(ctx.host, port, ctx.params?.timeout ?? 1000, false);
    return { value: r.ms ?? null, ok: r.open, series: { state: r.state }, raw: `${ctx.host}:${port} ${r.state}` };
  },

  async diagnose(ctx) {
    const timeout = ctx.params?.timeout ?? 500;
    const scanned = await pool(COMMON_PORTS, (p) => checkPort(ctx.host, p, timeout, false));
    const open = scanned.filter((r) => r.open).sort((a, b) => a.port - b.port);
    const anyRefused = scanned.some((r) => r.state === 'closed');
    const s = openSummary(open);
    return {
      facts: { host: { up: open.length > 0 || anyRefused, open_count: open.length }, scan: s },
      rulepack: 'ipscan',
      raw: `${ctx.host}: ${open.length} open [${open.map((o) => o.port).join(', ')}]`,
      decode: open,
    };
  },
};

export { cidrHosts, checkPort, SERVICES };
