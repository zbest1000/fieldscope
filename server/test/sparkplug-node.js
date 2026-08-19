// Sparkplug B edge-node simulator for tests and the sim lab. Connects to an MQTT
// broker and publishes a Sparkplug lifecycle: NBIRTH (seq 0) with metrics, then
// NDATA with incrementing sequence numbers — optionally injecting a sequence gap
// or an NDEATH, so the driver's seq-gap and lifecycle verdicts run end-to-end.
// Uses the driver's own protobuf encoder to guarantee wire agreement.

import mqttlib from 'mqtt';
import { encodePayload } from '../src/drivers/sparkplug.js';

export function startSparkplugNode({
  brokerPort,
  group = 'Plant1',
  node = 'Line3',
  intervalMs = 120,
  gapAfter = null, // skip one seq value after this many DATA messages
  emitDeathAfter = null, // publish NDEATH after this many DATA messages
  rebirthEvery = null, // re-publish NBIRTH (seq→0) every N data messages
} = {}) {
  const client = mqttlib.connect(`mqtt://127.0.0.1:${brokerPort}`, {
    protocolVersion: 4,
    clientId: `spnode_${group}_${node}`,
    reconnectPeriod: 0,
    clean: true,
  });

  const base = `spBv1.0/${group}`;
  let seq = 0;
  let dataCount = 0;
  let timer = null;
  let skipped = false;

  const nextSeq = () => {
    const s = seq;
    seq = (seq + 1) & 0xff;
    return s;
  };

  const publishBirth = () => {
    seq = 0; // NBIRTH resets the sequence to 0
    client.publish(
      `${base}/NBIRTH/${node}`,
      encodePayload({
        seq: nextSeq(),
        timestamp: 1,
        metrics: [
          { name: 'Temperature', alias: 1, datatype: 9, intValue: 72 },
          { name: 'Pressure', alias: 2, datatype: 9, intValue: 30 },
          { name: 'RunState', alias: 3, datatype: 11, intValue: 1 },
        ],
      }),
      { qos: 0 },
    );
  };

  client.on('connect', () => {
    publishBirth();

    timer = setInterval(() => {
      if (rebirthEvery != null && dataCount > 0 && dataCount % rebirthEvery === 0) {
        publishBirth();
      }
      dataCount += 1;
      // Optionally skip one sequence number to simulate a lost message.
      if (gapAfter != null && dataCount === gapAfter + 1 && !skipped) {
        nextSeq(); // burn a seq without publishing → the next publish shows a gap
        skipped = true;
      }
      client.publish(
        `${base}/NDATA/${node}`,
        encodePayload({ seq: nextSeq(), timestamp: dataCount, metrics: [{ alias: 1, datatype: 9, intValue: 72 + dataCount }] }),
        { qos: 0 },
      );
      if (emitDeathAfter != null && dataCount === emitDeathAfter) {
        client.publish(`${base}/NDEATH/${node}`, encodePayload({ seq: nextSeq(), timestamp: dataCount }), { qos: 0 });
      }
    }, intervalMs);
  });

  return {
    client,
    stop: () =>
      new Promise((resolve) => {
        if (timer) clearInterval(timer);
        client.end(true, {}, () => resolve());
      }),
  };
}
