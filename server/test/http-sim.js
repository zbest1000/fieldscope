// Minimal HTTP device simulator for tests and the sim lab. Serves a JSON health
// body on / and honors a few paths that force specific status classes so the
// driver's verdicts (2xx/3xx/4xx/5xx) run end-to-end.
//
//   GET /            → 200 application/json  {status, uptime, firmware, tags{…}}
//   GET /health      → 200 application/json
//   GET /secure      → 401
//   GET /missing     → 404
//   GET /boom        → 500
//   GET /elsewhere   → 302 Location: /

import http from 'node:http';

export function startHttpSim({ port = 0, firmware = '1.4.2' } = {}) {
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/secure') return end(res, 401, 'text/plain', 'auth required');
    if (path === '/missing') return end(res, 404, 'text/plain', 'not found');
    if (path === '/boom') return end(res, 500, 'text/plain', 'internal error');
    if (path === '/elsewhere') { res.writeHead(302, { Location: '/' }); return res.end(); }
    const body = JSON.stringify({ status: 'ok', uptime_s: 12345, firmware, tags: { temperature_c: 42.5, pump_running: true } });
    end(res, 200, 'application/json', body);
  });
  function end(res, status, type, body) {
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), Server: 'fieldscope-sim/1.0' });
    res.end(body);
  }
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, close: () => server.close(), port: server.address().port }));
  });
}
