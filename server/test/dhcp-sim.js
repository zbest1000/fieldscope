// DHCP server simulator for tests and the sim lab. Answers a DISCOVER with one
// or more OFFERs (configurable) so the driver's option decode and rogue /
// multi-server verdict run end-to-end. Replies to the sender (unicast) so it
// works unprivileged on loopback.

import dgram from 'node:dgram';

const MAGIC = Buffer.from([0x63, 0x82, 0x53, 0x63]);

function buildOffer(reqXid, chaddr, { yourIp, serverId, subnet, router, dns, lease, domain }) {
  const buf = Buffer.alloc(240);
  buf[0] = 2; // BOOTREPLY
  buf[1] = 1;
  buf[2] = 6;
  reqXid.copy(buf, 4);
  ipBytes(yourIp).copy(buf, 16); // yiaddr
  ipBytes(serverId).copy(buf, 20); // siaddr
  chaddr.copy(buf, 28, 0, 6);
  MAGIC.copy(buf, 236);
  const opts = [
    53, 1, 2, // OFFER
    1, 4, ...ipBytes(subnet),
    3, 4, ...ipBytes(router),
    6, 4, ...ipBytes(dns),
    51, 4, (lease >>> 24) & 255, (lease >>> 16) & 255, (lease >>> 8) & 255, lease & 255,
    54, 4, ...ipBytes(serverId),
  ];
  if (domain) opts.push(15, domain.length, ...Buffer.from(domain, 'latin1'));
  opts.push(255);
  return Buffer.concat([buf, Buffer.from(opts)]);
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
    // DISCOVER is message type 53 = 1; reply from every configured server.
    const xid = msg.subarray(4, 8);
    const chaddr = msg.subarray(28, 34);
    for (const cfg of configs) {
      sock.send(buildOffer(xid, chaddr, cfg), rinfo.port, rinfo.address);
    }
  });

  return new Promise((resolve) => {
    sock.bind(port, '127.0.0.1', () => {
      resolve({ sock, port: sock.address().port, close: () => sock.close() });
    });
  });
}
