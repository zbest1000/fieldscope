// Commissioning report renderer (§7 "Evidence & reporting", §12 phase 8).
// Turns a session's evidence into a self-contained, print-friendly HTML
// deliverable: verdicts up top ("what is wrong and why"), the full artifact
// timeline underneath, and the session's audit trail. Credentials are redacted
// on the way out (§8, credential vault: never included in a session export).

import { severityRank } from '../contract/contract.js';

const REDACT_KEY = /pass(word)?|secret|community|credential|token|api[-_]?key|private/i;

// Deep-copy a JSON-ish value, masking anything that looks like a credential.
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEY.test(k) && v != null && typeof v !== 'object' ? '•••redacted•••' : redact(v);
    }
    return out;
  }
  return value;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SEV_COLOR = { ok: '#15803d', info: '#0369a1', warn: '#b45309', error: '#b91c1c' };

function verdictBadge(v) {
  const color = SEV_COLOR[v.severity] || SEV_COLOR.info;
  return `<span class="sev" style="background:${color}">${esc(v.severity)}</span>`;
}

function fmtTime(ms) {
  return ms ? new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC') : '—';
}

function resultSummary(result) {
  if (result == null) return '';
  const json = JSON.stringify(redact(result), null, 1);
  return json.length > 2000 ? `${json.slice(0, 2000)}\n… (truncated)` : json;
}

export function renderSessionReport({ session, artifacts, audit, generatedAt = Date.now() }) {
  if (!session) throw new Error('unknown session');

  const verdicts = artifacts.flatMap((a) => (a.verdicts || []).map((v) => ({ ...v, artifact: a })));
  const counts = { ok: 0, info: 0, warn: 0, error: 0 };
  for (const v of verdicts) counts[v.severity] = (counts[v.severity] || 0) + 1;
  const findings = verdicts
    .filter((v) => v.severity === 'warn' || v.severity === 'error')
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const writes = audit.filter((a) => a.session_id === session.id);

  const findingsHtml = findings.length
    ? findings
        .map(
          (v) => `
      <div class="finding">
        ${verdictBadge(v)} <strong>${esc(v.title)}</strong>
        <div class="detail">${esc(v.detail)}</div>
        ${(v.next_steps || []).length ? `<ul>${v.next_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
        <div class="meta">rule ${esc(v.rule_id || '—')} · artifact ${esc(v.artifact.id)} · ${esc(v.artifact.verb)}</div>
      </div>`,
        )
        .join('')
    : '<p class="allclear">No warnings or errors — all verdicts came back clean.</p>';

  const timelineHtml = artifacts
    .map(
      (a) => `
    <tr>
      <td class="mono">#${a.seq}</td>
      <td class="mono">${fmtTime(a.timestamp_ptp)}</td>
      <td><span class="verb">${esc(a.verb)}</span></td>
      <td>${(a.verdicts || []).map((v) => `${verdictBadge(v)} ${esc(v.title)}`).join('<br>') || '—'}</td>
      <td><pre>${esc(resultSummary(a.result))}</pre>${a.error ? `<div class="err">error: ${esc(a.error)}</div>` : ''}</td>
    </tr>`,
    )
    .join('');

  const auditHtml = writes.length
    ? `<table>
        <thead><tr><th>time</th><th>action</th><th>target</th><th>point</th><th>before → after</th><th>confirmation</th></tr></thead>
        <tbody>${writes
          .map(
            (w) => `
          <tr>
            <td class="mono">${fmtTime(w.timestamp)}</td>
            <td>${esc(w.action)}</td>
            <td class="mono">${esc(w.target)}</td>
            <td class="mono">${esc(w.point)}</td>
            <td class="mono">${esc(w.before_value ?? '—')} → ${esc(w.after_value ?? '—')}</td>
            <td class="mono">${esc(w.confirmation)}</td>
          </tr>`,
          )
          .join('')}</tbody>
      </table>`
    : '<p class="allclear">No armed actions or writes in this session — it stayed read-only throughout.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fieldscope report — ${esc(session.driver_id)} ${esc(session.address)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1e293b; margin: 0; background: #f8fafc; }
  .page { max-width: 900px; margin: 0 auto; padding: 32px 24px 64px; }
  header { border-bottom: 3px solid #0f172a; padding-bottom: 12px; margin-bottom: 24px; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em; color: #475569; margin: 32px 0 10px; }
  .sub { color: #64748b; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin-top: 14px; }
  .cell { background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 12px; }
  .cell .k { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; }
  .cell .v { font-family: ui-monospace, monospace; font-size: 13px; }
  .counts span { display: inline-block; margin-right: 12px; font-weight: 600; }
  .sev { color: #fff; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; border-radius: 3px; padding: 1px 6px; margin-right: 6px; }
  .finding { background: #fff; border: 1px solid #e2e8f0; border-left: 4px solid #b45309; border-radius: 4px; padding: 10px 14px; margin-bottom: 10px; }
  .finding .detail { margin-top: 4px; color: #475569; }
  .finding .meta { margin-top: 6px; font-size: 11px; color: #94a3b8; font-family: ui-monospace, monospace; }
  .finding ul { margin: 6px 0 0 18px; color: #334155; }
  .allclear { color: #15803d; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e2e8f0; font-size: 12px; }
  th { text-align: left; background: #f1f5f9; padding: 6px 10px; color: #64748b; font-weight: 600; }
  td { padding: 6px 10px; border-top: 1px solid #e2e8f0; vertical-align: top; }
  td pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 11px; color: #475569; max-width: 420px; }
  .mono { font-family: ui-monospace, monospace; white-space: nowrap; }
  .verb { text-transform: capitalize; }
  .err { color: #b91c1c; font-family: ui-monospace, monospace; font-size: 11px; }
  footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; }
  @media print { body { background: #fff; } .page { padding: 0; } }
</style>
</head>
<body>
<div class="page">
  <header>
    <h1>Fieldscope commissioning report</h1>
    <div class="sub">${esc(session.driver_id)} · ${esc(session.address)} · session ${esc(session.id)}</div>
    <div class="grid">
      <div class="cell"><div class="k">operator</div><div class="v">${esc(session.operator)}</div></div>
      <div class="cell"><div class="k">started</div><div class="v">${fmtTime(session.started_at)}</div></div>
      <div class="cell"><div class="k">ended</div><div class="v">${fmtTime(session.ended_at)}</div></div>
      <div class="cell"><div class="k">clock anchor</div><div class="v">${esc(session.clock_anchor)}</div></div>
      <div class="cell"><div class="k">artifacts</div><div class="v">${artifacts.length}</div></div>
      <div class="cell"><div class="k">verdicts</div><div class="v counts">
        ${Object.entries(counts).filter(([, n]) => n).map(([s, n]) => `<span style="color:${SEV_COLOR[s]}">${n} ${s}</span>`).join(' ') || '0'}
      </div></div>
    </div>
  </header>

  <h2>Findings (warnings &amp; errors)</h2>
  ${findingsHtml}

  <h2>Evidence timeline</h2>
  <table>
    <thead><tr><th>#</th><th>time</th><th>verb</th><th>verdict</th><th>result</th></tr></thead>
    <tbody>${timelineHtml}</tbody>
  </table>

  <h2>Write / ARM audit trail</h2>
  ${auditHtml}

  <footer>
    Generated ${fmtTime(generatedAt)} by Fieldscope · Connected Core Industries.
    Credentials are redacted from exports; raw byte blobs remain in the evidence store and are retrievable per-artifact.
  </footer>
</div>
</body>
</html>`;
}
