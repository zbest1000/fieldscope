// DHCP server simulator for tests and the sim lab. Answers a DISCOVER with one
// or more OFFERs (configurable) so the driver's option decode and rogue /
// multi-server verdict run end-to-end. Replies to the sender (unicast) so it
// works unprivileged on loopback.

import dgram from 'node:dgram';

const MAGIC = Buffer.from([0x63, 0x82, 0x53, 0x63]);

// Build a BOOTREPLY. msgType 2 = OFFER, 5 = ACK, 6 = NAK.
function buildReply(msgType, reqXid, chaddr, { yourIp, serverId, subnet, router, dns, lease, domain }) {
  const buf = Buffer.alloc(240);
  buf[0] = 2; // BOOTREPLY
  buf[1] = 1;
  buf[2] = 6;
  reqXid.copy(buf, 4);
  if (msgType !== 6) ipBytes(yourIp).copy(buf, 16); // yiaddr (NAK carries none)
  ipBytes(serverId).copy(buf, 20); // siaddr
  chaddr.copy(buf, 28, 0, 6);
  MAGIC.copy(buf, 236);
  const opts = [53, 1, msgType];
  if (msgType !== 6) {
    opts.push(
      1, 4, ...ipBytes(subnet),
      3, 4, ...ipBytes(router),
      6, 4, ...ipBytes(dns),
      51, 4, (lease >>> 24) & 255, (lease >>> 16) & 255, (lease >>> 8) & 255, lease & 255,
    );
  }
  opts.push(54, 4, ...ipBytes(serverId));
  if (msgType !== 6 && domain) opts.push(15, domain.length, ...Buffer.from(domain, 'latin1'));
  opts.push(255);
  return Buffer.concat([buf, Buffer.from(opts)]);
}

// Read a DHCP option's value bytes, or null.
function getOption(msg, code) {
  let o = 240;
  while (o < msg.length) {
    const c = msg[o++];
    if (c === 255) break;
    if (c === 0) continue;
    const len = msg[o++];
    const val = msg.subarray(o, o + len);
    o += len;
    if (c === code) return val;
  }
  return null;
}

function ipBytes(s) {
  return Buffer.from(s.split('.').map(Number));
}

export function startDhcpSim({ port = 0, offers = null } = {}) {
  // Default: a single legitimate server. Pass an array for multiple (rogue test).
  const configs = offers || [
    { yourIp: '10.10.0.50', serverId: '10.10.0.1', subnet: '255.255.255.0', router: '10.10.0.1', dns: '10.10.0.1', lease: 86400, domain: 'plant.local' },
  ];
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', (msg, rinfo) => {
    if (msg.length < 240 || msg.readUInt32BE(236) !== MAGIC.readUInt32BE(0)) return;
    const xid = msg.subarray(4, 8);
    const chaddr = msg.subarray(28, 34);
    const msgType = getOption(msg, 53)?.[0];
    if (msgType === 1) {
      // DISCOVER → OFFER from every configured server.
      for (const cfg of configs) sock.send(buildReply(2, xid, chaddr, cfg), rinfo.port, rinfo.address);
    } else if (msgType === 3) {
      // REQUEST → ACK (or NAK). Honor the requested IP; only the addressed
      // server (option 54) answers when the client named one.
      const reqIp = getOption(msg, 50);
      const wantServer = getOption(msg, 54);
      for (const cfg of configs) {
        if (wantServer && [...wantServer].join('.') !== cfg.serverId) continue;
        const yourIp = reqIp ? [...reqIp].join('.') : cfg.yourIp;
        // A server hands out a NAK if the requested address is outside its scope.
        const inScope = !cfg.pool || cfg.pool.includes(yourIp);
        sock.send(buildReply(inScope ? 5 : 6, xid, chaddr, { ...cfg, yourIp }), rinfo.port, rinfo.address);
      }
    }
  });

  return new Promise((resolve) => {
    sock.bind(port, '127.0.0.1', () => {
      resolve({ sock, port: sock.address().port, close: () => sock.close() });
    });
  });
}
