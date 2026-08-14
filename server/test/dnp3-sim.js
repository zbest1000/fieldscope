// Minimal DNP3 outstation simulator for tests and the sim lab. Answers a Link
// Status request and a Class 0 READ with a configurable IIN word, so the
// driver's addressing check and IIN-flag verdicts run end-to-end. Reuses the
// driver's own framing/CRC helpers to guarantee wire agreement.

import net from 'node:net';
import { dnp3Crc } from '../src/drivers/dnp3.js';

function appendCrc(block) {
  const crc = dnp3Crc(block);
  return Buffer.concat([block, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}

function buildFrame(control, dest, src, userData = Buffer.alloc(0)) {
  const header = Buffer.alloc(8);
  header[0] = 0x05;
  header[1] = 0x64;
  header[2] = 5 + userData.length;
  header[3] = control;
  header.writeUInt16LE(dest & 0xffff, 4);
  header.writeUInt16LE(src & 0xffff, 6);
  const out = [appendCrc(header)];
  for (let off = 0; off < userData.length; off += 16) out.push(appendCrc(userData.subarray(off, off + 16)));
  return Buffer.concat(out);
}

function frameComplete(buf) {
  if (buf.length < 10 || buf[0] !== 0x05 || buf[1] !== 0x64) return false;
  const userLen = Math.max(0, buf[2] - 5);
  return buf.length >= 10 + userLen + Math.ceil(userLen / 16) * 2;
}

export function startDnp3Sim({ port = 0, outstation = 1024, iin1 = 0x00, iin2 = 0x00 } = {}) {
  const server = net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (frameComplete(pending)) {
        const userLen = Math.max(0, pending[2] - 5);
        const total = 10 + userLen + Math.ceil(userLen / 16) * 2;
        handle(pending.subarray(0, total), socket);
        pending = pending.subarray(total);
      }
    });
    socket.on('error', () => {});
  });

  function handle(frame, socket) {
    const control = frame[3];
    const func = control & 0x0f;
    const master = frame.readUInt16LE(6); // request src → our dest
    if (func === 0x09) {
      // Request Link Status → Link Status (function 11), DIR=0, PRM=0.
      socket.write(buildFrame(0x0b, master, outstation, Buffer.alloc(0)));
    } else if (func === 0x04 || func === 0x03) {
      // (Un)confirmed user data carrying an application READ → RESPONSE with IIN.
      const transport = Buffer.from([0xc0]);
      const app = Buffer.from([0xc0, 0x81, iin1, iin2]); // ctrl, RESPONSE, IIN1, IIN2
      // DIR=0 (from outstation), PRM=1, function 3 (unconfirmed user data)... use
      // unconfirmed user data 0x44 -> DIR bit clear: 0x44 = PRM=1,func=4.
      socket.write(buildFrame(0x44, master, outstation, Buffer.concat([transport, app])));
    }
  }

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
