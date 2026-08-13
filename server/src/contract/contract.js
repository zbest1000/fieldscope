// The driver contract (§4).
//
// Every protocol plugin declares a capability manifest and implements whichever
// verbs apply. The rest of Fieldscope — UI, logging, evidence, rules — is
// written once against this contract. Adding a protocol never touches those
// layers; that plugin boundary is the architectural keystone (§3).

export const DOMAINS = ['it', 'industrial', 'utility', 'iiot', 'iot-rf'];

// The nine contract verbs (§4). Order is the canonical UI tab order.
export const VERBS = [
  'discover',
  'connect',
  'identify',
  'browse',
  'read',
  'write',
  'monitor',
  'decode',
  'diagnose',
];

export const SEVERITIES = ['ok', 'info', 'warn', 'error'];

// A manifest is the declarative half of a driver. Defaults fill in the
// conservative, read-only, no-special-hardware case so a minimal driver only
// declares id / display_name / domain / verbs.
export function normalizeManifest(m) {
  if (!m || typeof m !== 'object') throw new Error('driver manifest missing');
  if (!m.id) throw new Error('driver manifest missing id');
  if (!DOMAINS.includes(m.domain)) {
    throw new Error(`driver ${m.id}: invalid domain ${m.domain}`);
  }
  const verbs = Array.isArray(m.verbs) ? m.verbs : [];
  for (const v of verbs) {
    if (!VERBS.includes(v)) throw new Error(`driver ${m.id}: unknown verb ${v}`);
  }
  return {
    id: m.id,
    display_name: m.display_name || m.id,
    domain: m.domain,
    group: m.group || m.domain,
    transport: m.transport || [],
    default_port: m.default_port ?? null,
    requires_l2: !!m.requires_l2,
    requires_admin: !!m.requires_admin,
    requires_hardware: m.requires_hardware || null,
    catalog_formats: m.catalog_formats || [],
    write_capable: !!m.write_capable,
    safety_locked: !!m.safety_locked,
    mode: m.mode || 'full', // full | observe | hw
    lib: m.lib || null, // maturity note, for the catalog
    verbs,
    // Optional per-verb parameter hints the UI renders as form fields.
    params: m.params || {},
    describe: m.describe || null, // free-text diagnostic focus (catalog)
  };
}

// Every verb returns an Artifact (§4). This factory guarantees the uniform
// shape the evidence store, replay, diff, and export all depend on.
export function makeArtifact({
  verb,
  raw = null,
  decode = null,
  result = null,
  verdicts = null,
  error = null,
}) {
  return {
    verb,
    // raw is the actual bytes on the wire (hex string or buffer summary) so the
    // Raw tab can prove the tool isn't lying (§2, "Verify the tool").
    raw: raw == null ? null : rawView(raw),
    decode,
    result,
    // verdicts may be attached here by a driver, or later by the rules engine.
    verdicts: verdicts || [],
    error: error ? String(error.message || error) : null,
  };
}

// Normalize raw bytes into a portable { hex, ascii, len } view plus keep the
// original buffer for the blob store when present.
export function rawView(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    // A plain string is a human-readable transcript, not hex bytes.
    return { text: raw, len: raw.length };
  }
  // Already-structured raw views pass through untouched (e.g. Modbus { tx, rx }
  // hex, or a driver that pre-formatted { hex, ascii }).
  if (
    raw &&
    typeof raw === 'object' &&
    !(raw instanceof Uint8Array) &&
    (raw.tx !== undefined || raw.rx !== undefined || raw.hex !== undefined || raw.text !== undefined)
  ) {
    return raw;
  }
  let buf = raw;
  if (!(buf instanceof Uint8Array)) {
    if (buf.data && Array.isArray(buf.data)) buf = Uint8Array.from(buf.data);
    else return { hex: '', len: 0, text: String(raw) };
  }
  const bytes = Buffer.from(buf);
  return {
    hex: bytes.toString('hex'),
    ascii: bytes.toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
    len: bytes.length,
  };
}

export function severityRank(sev) {
  return Math.max(0, SEVERITIES.indexOf(sev));
}
