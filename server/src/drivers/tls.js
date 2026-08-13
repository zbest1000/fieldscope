// TLS / certificate inspector (§6.1). Chain, expiry, cipher, policy audit — a
// diagnostics tool must inspect broken chains, so it never rejects on validation.

import { tlsInspect } from '../transport/transport.js';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'tls',
  display_name: 'TLS / Cert Inspector',
  domain: 'it',
  group: 'tools',
  transport: ['tcp', 'tls'],
  default_port: 443,
  mode: 'full',
  lib: '🟢',
  describe: 'Chain, expiry, cipher, policy audit.',
  verbs: ['identify', 'diagnose'],
};

function certInfo(cert) {
  if (!cert || !cert.subject) return null;
  const validTo = cert.valid_to ? Date.parse(cert.valid_to) : null;
  const validFrom = cert.valid_from ? Date.parse(cert.valid_from) : null;
  const daysToExpiry = validTo ? Math.floor((validTo - Date.now()) / 86400000) : null;
  return {
    subject_cn: cert.subject.CN || null,
    issuer_cn: cert.issuer ? cert.issuer.CN || null : null,
    valid_from: cert.valid_from || null,
    valid_to: cert.valid_to || null,
    days_to_expiry: daysToExpiry,
    self_signed:
      cert.subject && cert.issuer
        ? JSON.stringify(cert.subject) === JSON.stringify(cert.issuer)
        : null,
    fingerprint: cert.fingerprint256 || cert.fingerprint || null,
    key_bits: cert.bits || null,
  };
}

async function inspect(host, port, timeout) {
  try {
    const r = await tlsInspect(host, port, timeout);
    const info = certInfo(r.cert);
    return {
      ok: true,
      protocol: r.protocol,
      cipher: r.cipher ? r.cipher.name : null,
      authorized: r.authorized,
      auth_error: r.authError,
      cert: info,
      handshake_ms: r.handshakeMs,
      error: null,
    };
  } catch (err) {
    return { ok: false, error: err.code || err.message };
  }
}

export const verbs = {
  async identify(ctx) {
    const r = await inspect(ctx.host, ctx.port || 443, ctx.params?.timeout ?? 5000);
    return {
      artifact: makeArtifact({
        verb: 'identify',
        raw: JSON.stringify(r, null, 2),
        result: r,
      }),
      facts: {
        ok: r.ok,
        authorized: r.authorized,
        auth_error: r.auth_error,
        days_to_expiry: r.cert ? r.cert.days_to_expiry : null,
        self_signed: r.cert ? r.cert.self_signed : null,
        protocol: r.protocol,
      },
    };
  },

  async diagnose(ctx) {
    const r = await inspect(ctx.host, ctx.port || 443, ctx.params?.timeout ?? 5000);
    return {
      facts: {
        ok: r.ok,
        authorized: r.authorized,
        auth_error: r.auth_error,
        days_to_expiry: r.cert ? r.cert.days_to_expiry : null,
        self_signed: r.cert ? r.cert.self_signed : null,
        protocol: r.protocol,
        error: r.error,
      },
      rulepack: 'tls',
      raw: JSON.stringify(r, null, 2),
    };
  },
};
