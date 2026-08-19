// IEC 60870-5-104 station simulator for tests and the sim lab. Implements the
// APCI state machine (STARTDT / STOPDT / TESTFR) and answers a General
// Interrogation with an activation-confirm, a short-float data frame, and an
// activation-termination — so the driver's STARTDT handshake, GI sequence, and
// common-address / negative-confirm verdicts run end-to-end. Reuses the driver's
// APCI builders/parsers to guarantee wire agreement.

import net from 'node:net';
import { buildU, buildI, splitApdus, parseApdu } from '../src/drivers/iec104.js';

const U = { STARTDT_act: 0x07, STARTDT_con: 0x0b, STOPDT_act: 0x13, STOPDT_con: 0x23, TESTFR_act: 0x43, TESTFR_con: 0x83 };

function asduHead(typeId, numObjects, cot, commonAddress) {
  const ca = Buffer.alloc(2); ca.writeUInt16LE(commonAddress & 0xffff, 0);
  return Buffer.concat([Buffer.from([typeId, numObjects & 0x7f, cot & 0xff, 0x00]), ca]);
}
const ioaBytes = (ioa) => Buffer.from([ioa & 0xff, (ioa >> 8) & 0xff, (ioa >> 16) & 0xff]);

function asduInterrogationReply(cot, commonAddress) {
  // C_IC_NA_1 confirmation/termination: 1 object, IOA 0, QOI 20.
  return Buffer.concat([asduHead(100, 1, cot, commonAddress), ioaBytes(0), Buffer.from([0x14])]);
}
function asduFloatData(cot, commonAddress, points) {
  const bodies = points.map((p) => {
    const v = Buffer.alloc(4); v.writeFloatLE(p.value, 0);
    return Buffer.concat([ioaBytes(p.ioa), v, Buffer.from([0x00])]); // + QDS good
  });
  return Buffer.concat([asduHead(13, points.length, cot, commonAddress), ...bodies]);
}
function asduSinglePointData(cot, commonAddress, points) {
  const bodies = points.map((p) => Buffer.concat([ioaBytes(p.ioa), Buffer.from([p.value & 0x01])])); // SIQ
  return Buffer.concat([asduHead(1, points.length, cot, commonAddress), ...bodies]);
}
function asduCommandReply(cot, commonAddress, ioa, sco) {
  // C_SC_NA_1 confirmation/termination echoes the IOA + SCO.
  return Buffer.concat([asduHead(45, 1, cot, commonAddress), ioaBytes(ioa), Buffer.from([sco & 0xff])]);
}
// Encode a 7-byte CP56Time2a timestamp from calendar fields.
function encodeCp56Time2a({ year, month, day, hour, minute, second = 0, ms = 0 }) {
  const b = Buffer.alloc(7);
  b.writeUInt16LE((second * 1000 + ms) & 0xffff, 0);
  b[2] = minute & 0x3f;
  b[3] = hour & 0x1f;
  b[4] = day & 0x1f;
  b[5] = month & 0x0f;
  b[6] = (year - 2000) & 0x7f;
  return b;
}
// M_SP_TB_1: single-point status with a CP56Time2a event timestamp.
function asduSinglePointTimeData(cot, commonAddress, ioa, value, timeBuf) {
  return Buffer.concat([asduHead(30, 1, cot, commonAddress), ioaBytes(ioa), Buffer.from([value & 0x01]), timeBuf]);
}

export function startIec104Sim({ port = 0, commonAddress = 1, startdt = true, giNegative = false, points = null, commandNegative = false } = {}) {
  const pts = points || [
    { ioa: 1001, value: 230.4 }, // busbar voltage
    { ioa: 1002, value: 12.7 }, // feeder current
    { ioa: 1003, value: 50.02 }, // frequency
  ];
  const singlePoints = [{ ioa: 2001, value: 0 }]; // a controllable breaker (open)
  const spOf = (ioa) => singlePoints.find((p) => p.ioa === ioa);
  // A time-tagged event (M_SP_TB_1) delivered spontaneously in the GI window, so
  // the driver's CP56Time2a decode is exercised end-to-end. Fixed for determinism.
  const timeEvent = { ioa: 2101, value: 1, at: { year: 2026, month: 8, day: 16, hour: 14, minute: 30, second: 12, ms: 345 } };
  const server = net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    let ns = 0; // our send sequence
    let recvI = 0; // count of I-frames received (→ our N(R))
    const sendI = (asdu) => { socket.write(buildI(ns++, recvI, asdu)); };

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const { frames, rest } = splitApdus(pending);
      pending = rest;
      for (const f of frames) handle(parseApdu(f));
    });
    socket.on('error', () => {});

    function handle(apdu) {
      if (apdu.format === 'U') {
        if (apdu.u === 'STARTDT_act' && startdt) socket.write(buildU(U.STARTDT_con));
        else if (apdu.u === 'STOPDT_act') socket.write(buildU(U.STOPDT_con));
        else if (apdu.u === 'TESTFR_act') socket.write(buildU(U.TESTFR_con));
        return;
      }
      if (apdu.format === 'I' && apdu.asdu && !apdu.asdu.error) {
        recvI += 1;
        // General Interrogation command.
        if (apdu.asdu.type_id === 100 && apdu.asdu.cot === 6) {
          const reqCA = apdu.asdu.common_address;
          if (reqCA !== commonAddress) {
            // Unknown common address → COT 46 reject, no data.
            sendI(asduInterrogationReply(46, reqCA));
            return;
          }
          if (giNegative) {
            // Activation confirmation with the P/N bit set (negative), no data.
            sendI(asduInterrogationReply(7 | 0x40, commonAddress));
            return;
          }
          sendI(asduInterrogationReply(7, commonAddress)); // activation confirmation
          sendI(asduFloatData(20, commonAddress, pts)); // interrogated measured data
          sendI(asduSinglePointData(20, commonAddress, singlePoints)); // interrogated status
          sendI(asduSinglePointTimeData(3, commonAddress, timeEvent.ioa, timeEvent.value, encodeCp56Time2a(timeEvent.at))); // spontaneous time-tagged event
          sendI(asduInterrogationReply(10, commonAddress)); // activation termination
          return;
        }
        // Single command (C_SC_NA_1) with select-before-operate.
        if (apdu.asdu.type_id === 45 && apdu.asdu.cot === 6) {
          const obj = apdu.asdu.objects[0] || {};
          const sco = (obj.select ? 0x80 : 0x00) | (obj.scs ? 0x01 : 0x00);
          if (commandNegative) { sendI(asduCommandReply(7 | 0x40, commonAddress, obj.ioa, sco)); return; }
          if (obj.select) {
            sendI(asduCommandReply(7, commonAddress, obj.ioa, sco)); // SELECT confirmed
          } else {
            const sp = spOf(obj.ioa);
            if (sp) sp.value = obj.scs; // EXECUTE: operate the point
            sendI(asduCommandReply(7, commonAddress, obj.ioa, sco)); // EXECUTE confirmed
            sendI(asduCommandReply(10, commonAddress, obj.ioa, sco)); // activation termination
          }
        }
      }
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, close: () => server.close() }));
  });
}
