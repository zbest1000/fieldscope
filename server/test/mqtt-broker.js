// Minimal MQTT broker for tests and the sim lab, built on aedes (pure JS).
// Supports an optional credential requirement so the CONNACK-refusal verdicts
// can be exercised end-to-end.

import net from 'node:net';
import aedes from 'aedes';

export function startMqttBroker({ port = 0, username = null, password = null } = {}) {
  const broker = aedes();

  if (username) {
    broker.authenticate = (client, u, p, done) => {
      const ok = u === username && p && p.toString() === password;
      if (ok) return done(null, true);
      const err = new Error('not authorized');
      err.returnCode = 5; // CONNACK not authorized
      done(err, null);
    };
  }

  const server = net.createServer(broker.handle);
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        broker,
        server,
        port: server.address().port,
        close: () =>
          new Promise((r) => {
            broker.close(() => server.close(() => r()));
          }),
      });
    });
  });
}
