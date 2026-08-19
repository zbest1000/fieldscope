// Minimal DNS-over-UDP server for tests and the sim lab. Answers A / AAAA / MX /
// TXT / NS / CNAME queries for a configured zone so the driver's record-type
// reads run end-to-end against a real resolver (Node's dns.Resolver pointed at
// this server). Names in answers use a compression pointer back to the question;
// unknown name/type pairs return NODATA (ancount 0).

import dgram from 'node:dgram';

const TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28 };
const TYPE_NAME = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]));

function encodeName(name) {
  const labels = String(name).split('.').filter(Boolean);
  return Buffer.concat([...labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'latin1')])), Buffer.from([0])]);
}

function parseQuestion(msg) {
  let o = 12;
  const labels = [];
  while (o < msg.length && msg[o] !== 0) {
    const len = msg[o];
    labels.push(msg.subarray(o + 1, o + 1 + len).toString('latin1'));
    o += 1 + len;
  }
  o += 1; // terminating zero
  const qtype = msg.readUInt16BE(o);
  return { id: msg.readUInt16BE(0), name: labels.join('.'), qtype, questionEnd: o + 4 };
}

// Build the RDATA for one record of a given type.
function rdata(type, value) {
  switch (type) {
    case TYPE.A: return Buffer.from(value.split('.').map(Number));
    case TYPE.AAAA: {
      const b = Buffer.alloc(16);
      value.split(':').forEach((h, i) => b.writeUInt16BE(parseInt(h || '0', 16), i * 2));
      return b;
    }
    case TYPE.TXT: { const s = Buffer.from(value, 'latin1'); return Buffer.concat([Buffer.from([s.length]), s]); }
    case TYPE.MX: { const pref = Buffer.alloc(2); pref.writeUInt16BE(value.preference, 0); return Buffer.concat([pref, encodeName(value.exchange)]); }
    case TYPE.NS:
    case TYPE.CNAME:
    case TYPE.PTR: return encodeName(value);
    default: return Buffer.alloc(0);
  }
}

export function startDnsSim({ port = 0, zone = null } = {}) {
  const records = zone || {
    'plc.plant.local': { A: ['10.0.0.5', '10.0.0.6'], TXT: ['site=plant1'], MX: [{ preference: 10, exchange: 'mail.plant.local' }], NS: ['ns1.plant.local'] },
    'gw.plant.local': { A: ['10.0.0.1'], CNAME: [] },
  };
  const sock = dgram.createSocket('udp4');

  sock.on('message', (msg, rinfo) => {
    if (msg.length < 12) return;
    const q = parseQuestion(msg);
    const typeName = TYPE_NAME[q.qtype];
    const answers = (records[q.name] && typeName && records[q.name][typeName]) || [];

    const header = Buffer.alloc(12);
    header.writeUInt16BE(q.id, 0);
    header.writeUInt16BE(0x8180, 2); // QR=1, RD=1, RA=1, RCODE=0
    header.writeUInt16BE(1, 4); // QDCOUNT
    header.writeUInt16BE(answers.length, 6); // ANCOUNT
    const question = msg.subarray(12, q.questionEnd);

    const rrs = answers.map((val) => {
      const rd = rdata(q.qtype, val);
      const head = Buffer.alloc(12);
      head.writeUInt16BE(0xc00c, 0); // NAME → pointer to the question name
      head.writeUInt16BE(q.qtype, 2); // TYPE
      head.writeUInt16BE(1, 4); // CLASS IN
      head.writeUInt32BE(60, 6); // TTL
      head.writeUInt16BE(rd.length, 10); // RDLENGTH
      return Buffer.concat([head, rd]);
    });

    sock.send(Buffer.concat([header, question, ...rrs]), rinfo.port, rinfo.address);
  });

  return new Promise((resolve) => {
    sock.bind(port, '127.0.0.1', () => resolve({ sock, port: sock.address().port, close: () => sock.close() }));
  });
}
