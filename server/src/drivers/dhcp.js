// DHCP / BOOTP driver (§6.1). Broadcasts a DHCP DISCOVER and decodes every
// OFFER that comes back — offered address, lease, and the network options
// (subnet, router, DNS, domain, NTP). Collecting *all* offers in a window is
// the point: two servers answering one DISCOVER is the signature of a rogue or
// mis-scoped DHCP server, the top "why did this device get the wrong IP" fault.
//
// Note on privileges: real DHCP uses UDP 67/68 and broadcast; binding 68 needs
// root and receiving broadcast replies needs raw sockets on many stacks. The
// client port is configurable so the option/offer engine can run unprivileged
// against a known server (DHCP relay / unicast) or the sim lab; broadcast
// discovery on a live segment additionally needs the privileged port.

import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'dhcp',
  display_name: 'DHCP / BOOTP',
  domain: 'it',
  group: 'discovery',
  transport: ['udp'],
  default_port: 67,
  mode: 'full',
  lib: '🟢 raw options',
  describe: 'DHCP DISCOVER + OFFER option decode (subnet/router/DNS/lease); rogue / multi-server detection.',
  verbs: ['identify', 'diagnose'],
  params: {
    identify: {
      server: { type: 'string', default: '255.255.255.255' },
      server_port: { type: 'number', default: 67, min: 1, max: 65535 },
      client_port: { type: 'number', default: 0, min: 0, max: 65535 },
      window_ms: { type: 'number', default: 2500, min: 500, max: 10000 },
    },
    diagnose: {
      server: { type: 'string', default: '255.255.255.255' },
      server_port: { type: 'number', default: 67, min: 1, max: 65535 },
      client_port: { type: 'number', default: 0, min: 0, max: 65535 },
      window_ms: { type: 'number', default: 2500, min: 500, max: 10000 },
    },
  },
};

const MAGIC = Buffer.from([0x63, 0x82, 0x53, 0x63]);

// Build a DHCP DISCOVER (BOOTP request + DHCP options). Returns { buf, xid }.
export function buildDiscover(mac = crypto.randomBytes(6)) {
  const buf = Buffer.alloc(240);
  buf[0] = 1; // op = BOOTREQUEST
  buf[1] = 1; // htype = ethernet
  buf[2] = 6; // hlen
  buf[3] = 0; // hops
  const xid = crypto.randomBytes(4);
  xid.copy(buf, 4);
  buf.writeUInt16BE(0x0000, 8); // secs
  buf.writeUInt16BE(0x0000, 10); // flags (unicast; 0x8000 = broadcast)
  // ciaddr/yiaddr/siaddr/giaddr already zero
  mac.copy(buf, 28, 0, 6); // chaddr
  MAGIC.copy(buf, 236);
  const opts = Buffer.from([
    53, 1, 1, // DHCP message type = DISCOVER
    55, 10, 1, 3, 6, 15, 28, 42, 51, 54, 58, 59, // parameter request list
    57, 2, 0x05, 0xdc, // max message size 1500
    255, // end
  ]);
  return { buf: Buffer.concat([buf, opts]), xid: xid.readUInt32BE(0) };
}

const MSG_TYPE = { 1: 'DISCOVER', 2: 'OFFER', 3: 'REQUEST', 4: 'DECLINE', 5: 'ACK', 6: 'NAK', 7: 'RELEASE', 8: 'INFORM' };
const ip = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
const ipList = (b) => {
  const out = [];
  for (let i = 0; i + 4 <= b.length; i += 4) out.push(ip(b, i));
  return out;
};

export function parseReply(buf) {
  if (buf.length < 240 || buf.readUInt32BE(236) !== MAGIC.readUInt32BE(0)) return null;
  const reply = {
    xid: buf.readUInt32BE(4),
    your_ip: ip(buf, 16), // yiaddr
    next_server: ip(buf, 20), // siaddr
    options: {},
  };
  let o = 240;
  while (o < buf.length) {
    const code = buf[o++];
    if (code === 255 || code === undefined) break;
    if (code === 0) continue;
    const len = buf[o++];
    const val = buf.subarray(o, o + len);
    o += len;
    switch (code) {
      case 53: reply.message_type = MSG_TYPE[val[0]] || val[0]; break;
      case 1: reply.options.subnet_mask = ip(val, 0); break;
      case 3: reply.options.routers = ipList(val); break;
      case 6: reply.options.dns = ipList(val); break;
      case 15: reply.options.domain = val.toString('latin1'); break;
      case 28: reply.options.broadcast = ip(val, 0); break;
      case 42: reply.options.ntp = ipList(val); break;
      case 51: reply.options.lease_seconds = val.readUInt32BE(0); break;
      case 54: reply.server_id = ip(val, 0); break;
      case 58: reply.options.renewal_seconds = val.readUInt32BE(0); break;
      case 59: reply.options.rebinding_seconds = val.readUInt32BE(0); break;
      default: break;
    }
  }
  return reply;
}

// Send one DISCOVER and collect every reply within the window.
function discover(ctx) {
  const server = ctx.params?.server || '255.255.255.255';
  const serverPort = ctx.params?.server_port ?? 67;
  const clientPort = ctx.params?.client_port ?? 0;
  const windowMs = Math.min(10000, Math.max(500, ctx.params?.window_ms ?? 2500));
  const broadcast = server === '255.255.255.255' || server.endsWith('.255');
  const { buf, xid } = buildDiscover();

  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const offers = [];
    const seen = new Set(); // byte-identical frames are transport dups
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      resolve({ offers, xid, request: buf, error: err || null });
    };
    sock.on('error', (e) => finish(e.code || e.message));
    sock.on('message', (msg) => {
      const key = msg.toString('hex');
      if (seen.has(key)) return;
      seen.add(key);
      const r = parseReply(msg);
      if (r && r.xid === xid) offers.push(r);
    });
    const timer = setTimeout(() => finish(null), windowMs);
    sock.bind(clientPort, () => {
      try {
        if (broadcast) sock.setBroadcast(true);
      } catch { /* not permitted */ }
      sock.send(buf, serverPort, server, (e) => { if (e) finish(e.code || e.message); });
    });
  });
}

function dedupeServers(offers) {
  return [...new Set(offers.map((o) => o.server_id).filter(Boolean))];
}

function facts(res) {
  const offers = res.offers.filter((o) => o.message_type === 'OFFER' || o.message_type === undefined);
  const servers = dedupeServers(offers);
  return {
    transport: { udp: res.error ? 'error' : 'ok' },
    dhcp: {
      offers: offers.length,
      servers: servers.length,
      offered_ip: offers[0]?.your_ip || null,
      error: res.error || null,
    },
  };
}

export const verbs = {
  async identify(ctx) {
    const res = await discover(ctx);
    const offers = res.offers;
    const servers = dedupeServers(offers);
    return {
      artifact: makeArtifact({
        verb: 'identify',
        raw: `DISCOVER xid=0x${res.xid.toString(16)} → ${offers.length} reply(ies) from ${servers.length} server(s)${res.error ? ` · ${res.error}` : ''}`,
        decode: offers,
        result:
          offers.length === 0
            ? { offers: 0, note: res.error ? `error: ${res.error}` : 'no DHCP OFFER received in window' }
            : {
                offers: offers.length,
                servers,
                tree: [
                  {
                    area: `${offers.length} offer(s) from ${servers.length} server(s)`,
                    points: offers.map((o) => ({
                      ref: o.server_id || 'unknown',
                      value: o.your_ip,
                      type: `lease ${o.options.lease_seconds ?? '—'}s · gw ${o.options.routers?.[0] ?? '—'}`,
                    })),
                  },
                ],
                first_offer: offers[0],
              },
      }),
      facts: facts(res),
    };
  },

  async diagnose(ctx) {
    const res = await discover(ctx);
    return {
      facts: facts(res),
      rulepack: 'dhcp',
      raw: `DISCOVER → ${res.offers.length} offer(s), ${dedupeServers(res.offers).length} server(s)${res.error ? ` · ${res.error}` : ''}`,
      decode: res.offers,
    };
  },
};
