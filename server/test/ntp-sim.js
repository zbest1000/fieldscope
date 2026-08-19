// Minimal SNTP server simulator for tests and the sim lab. Answers a client
// request with a well-formed 48-byte NTP reply, echoing the client's transmit
// timestamp into Originate and stamping Receive/Transmit from the system clock.
// Configurable stratum / leap / dispersion so the driver's sync and offset
// verdicts run end-to-end. Can be told to skew its clock to force a large-offset.

import dgram from 'node:dgram';

const NTP_UNIX_EPOCH_DELTA = 2208988800;

export function startNtpSim({ port = 0, stratum = 2, leap = 0, refId = '10.0.0.1', rootDispersionMs = 20, skewMs = 0 } = {}) {
  const socket = dgram.createSocket('udp4');

  socket.on('message', (msg, rinfo) => {
    if (msg.length < 48) return;
    const reply = Buffer.alloc(48);
    reply[0] = (leap << 6) | (4 << 3) | 4; // LI | VN=4 | Mode=4 (server)
    reply[1] = stratum;
    reply[2] = msg[2] || 6; // poll
    reply[3] = 0xec; // precision ~ 2^-20
    writeFixed1616(reply, 4, 1); // root delay ~1ms-ish
    writeFixed1616(reply, 8, rootDispersionMs / 1000);
    writeRefId(reply, 12, stratum, refId);
    const now = Date.now() + skewMs;
    writeTs(reply, 16, now - 1000); // reference time
    // Originate = client's transmit timestamp (echo bytes 40..47 of the request).
    msg.copy(reply, 24, 40, 48);
    writeTs(reply, 32, now); // receive
    writeTs(reply, 40, now); // transmit
    socket.send(reply, rinfo.port, rinfo.address);
  });

  return new Promise((resolve) => {
    socket.bind(port, '127.0.0.1', () => resolve({ socket, close: () => socket.close(), port: socket.address().port }));
  });
}

function writeTs(buf, off, ms) {
  const secs = Math.floor(ms / 1000) + NTP_UNIX_EPOCH_DELTA;
  const frac = Math.floor(((ms % 1000) / 1000) * 0x100000000);
  buf.writeUInt32BE(secs >>> 0, off);
  buf.writeUInt32BE(frac >>> 0, off + 4);
}

function writeFixed1616(buf, off, seconds) {
  buf.writeUInt32BE(Math.round(seconds * 0x10000) >>> 0, off);
}

function writeRefId(buf, off, stratum, refId) {
  if (stratum <= 1) {
    Buffer.from(String(refId).padEnd(4, '\0').slice(0, 4), 'latin1').copy(buf, off);
  } else {
    const parts = String(refId).split('.').map((n) => parseInt(n, 10) & 0xff);
    for (let i = 0; i < 4; i++) buf[off + i] = parts[i] || 0;
  }
}
