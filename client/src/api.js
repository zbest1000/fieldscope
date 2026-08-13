// Thin fetch wrapper over the Fieldscope REST API. All protocol logic lives on
// the backend; the client only issues intents and renders artifacts.

async function req(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  drivers: () => req('GET', '/drivers'),
  rulepacks: () => req('GET', '/rulepacks'),
  reloadRules: () => req('POST', '/rulepacks/reload'),

  targets: () => req('GET', '/targets'),
  saveTarget: (t) => req('POST', '/targets', t),
  deleteTarget: (id) => req('DELETE', `/targets/${id}`),

  openSession: (s) => req('POST', '/sessions', s),
  sessions: () => req('GET', '/sessions'),
  artifacts: (id) => req('GET', `/sessions/${id}/artifacts`),
  closeSession: (id) => req('POST', `/sessions/${id}/close`),

  runVerb: (id, verb, params) => req('POST', `/sessions/${id}/verb/${verb}`, { params }),
  diagnose: (id, params) => req('POST', `/sessions/${id}/diagnose`, { params }),

  arm: (id, confirm) => req('POST', `/sessions/${id}/arm`, { confirm }),
  disarm: (id) => req('POST', `/sessions/${id}/disarm`),
  prepareWrite: (id, params) => req('POST', `/sessions/${id}/write/prepare`, { params }),
  confirmWrite: (id, token) => req('POST', `/sessions/${id}/write/confirm`, { token }),

  startMonitor: (id, params) => req('POST', `/sessions/${id}/monitor/start`, { params }),
  stopMonitor: (mid) => req('POST', `/monitor/${mid}/stop`),

  replay: (id) => req('GET', `/sessions/${id}/replay`),
  diff: (a, b) => req('GET', `/diff?a=${a}&b=${b}`),
  audit: () => req('GET', '/audit'),
};
