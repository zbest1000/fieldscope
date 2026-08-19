// Minimal CoAP server simulator for tests and the sim lab. Parses a CoAP GET,
// reconstructs the Uri-Path, and answers:
//   /.well-known/core → 2.05 Content, CoRE Link Format resource list
//   /sensors/temp     → 2.05 Content, a plain value
//   anything else     → 4.04 Not Found
// Echoes the request's message ID and token, as a CON→ACK exchange.

import dgram from 'node:dgram';

const LINKS = '</sensors/temp>;rt="temperature";if="sensor",</sensors/humidity>;rt="humidity";if="sensor",</actuators/led>;rt="light";if="actuator"';

export function startCoapSim({ port = 0 } = {}) {
  const socket = dgram.createSocket('udp4');

  socket.on('message', (msg, rinfo) => {
    const req = parseRequest(msg);
    if (!req) return;
    let reply;
    if (req.path === '/.well-known/core') reply = build(2, 5, req, LINKS, 40); // link-format
    else if (req.path === '/sensors/temp') reply = build(2, 5, req, '22.4', 0); // text/plain
    else reply = build(4, 4, req, '', null); // 4.04 Not Found
    socket.send(reply, rinfo.port, rinfo.address);
  });

  return new Promise((resolve) => {
    socket.bind(port, '127.0.0.1', () => resolve({ socket, close: () => socket.close(), port: socket.address().port }));
  });
}

function parseRequest(buf) {
  if (buf.length < 4) return null;
  const tkl = buf[0] & 0x0f;
  const token = buf.subarray(4, 4 + tkl);
  const messageId = (buf[2] << 8) | buf[3];
  let o = 4 + tkl;
  let optNum = 0;
  const segs = [];
  while (o < buf.length && buf[o] !== 0xff) {
    const b = buf[o]; o += 1;
    let delta = b >> 4;
    let len = b & 0x0f;
    if (delta === 13) { delta = buf[o] + 13; o += 1; } else if (delta === 14) { delta = ((buf[o] << 8) | buf[o + 1]) + 269; o += 2; }
    if (len === 13) { len = buf[o] + 13; o += 1; } else if (len === 14) { len = ((buf[o] << 8) | buf[o + 1]) + 269; o += 2; }
    optNum += delta;
    if (optNum === 11) segs.push(buf.subarray(o, o + len).toString('utf8')); // Uri-Path
    o += len;
  }
  return { messageId, token, path: '/' + segs.join('/') };
}

function build(cls, detail, req, payload, contentFormat) {
  const type = 2; // ACK
  const code = (cls << 5) | detail;
  const header = Buffer.from([0x40 | (type << 4) | req.token.length, code, (req.messageId >> 8) & 0xff, req.messageId & 0xff]);
  const parts = [header, req.token];
  if (contentFormat != null) parts.push(Buffer.from([(12 << 4) | 1, contentFormat & 0xff])); // Content-Format option (12)
  if (payload) parts.push(Buffer.from([0xff]), Buffer.from(payload, 'utf8'));
  return Buffer.concat(parts);
}
