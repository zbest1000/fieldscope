// BACnet/IP driver (§6.3, §12 phase 6). The flagship building-automation
// protocol and a third protocol *shape* again: connectionless UDP with a
// layered BVLL → NPDU → APDU frame and ASN.1-style application tagging. Who-Is
// / I-Am is the real diagnostic entry point on a building network ("is the
// controller even announcing itself, and on which device instance"), and a
// ReadProperty of the device object's system-status carries the health story.
//
// Implemented raw over UDP 47808 — the encoding is well-specified and small
// enough to build directly, which keeps the driver dependency-free while
// producing real bytes for the Raw tab and real verdicts for Diagnose.
//
// Scope note (honest, per §11): this targets a *known* device by unicast
// Who-Is. Broadcast discovery across a subnet and BBMD/foreign-device
// registration are real field concerns called out in the architecture but are
// left for the capture/adapter tiers; the verdicts name BBMD explicitly when a
// device is silent.

import { udpRequest } from '../transport/transport.js';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'bacnet',
  display_name: 'BACnet/IP',
  domain: 'utility',
  group: 'utility',
  transport: ['udp'],
  default_port: 47808,
  catalog_formats: ['epics'],
  mode: 'full',
  lib: '🟢 raw BVLL/NPDU/APDU',
  describe:
    'Who-Is/I-Am identify (device instance, vendor, segmentation), device system-status health, ReadProperty.',
  verbs: ['identify', 'read', 'monitor', 'diagnose'],
  params: {
    read: {
      property: {
        type: 'enum',
        options: ['system-status', 'object-name', 'vendor-name', 'model-name'],
        default: 'system-status',
      },
    },
  },
};

const OBJECT_TYPE = { DEVICE: 8 };
const PROP = {
  'object-name': 77,
  'system-status': 112,
  'vendor-name': 121,
  'model-name': 70,
  'vendor-identifier': 120,
};

// Device system-status enumeration (Clause 12.11.4).
const SYSTEM_STATUS = {
  0: 'operational',
  1: 'operational-read-only',
  2: 'download-required',
  3: 'download-in-progress',
  4: 'non-operational',
  5: 'backup-in-progress',
};

// A handful of the ASHRAE-registered vendor IDs (unknown IDs render numerically).
const VENDOR = {
  0: 'ASHRAE',
  2: 'Andover Controls',
  5: 'Johnson Controls',
  8: 'Delta Controls',
  10: 'Schneider Electric',
  17: 'Trane',
  24: 'Siemens Building Technologies',
  36: 'Automated Logic (ALC)',
  42: 'Tridium',
  50: 'Honeywell',
  62: 'KMC Controls',
  260: 'Reliable Controls',
};

// ---- BVLL / NPDU framing ---------------------------------------------------
function bvlcUnicast(apdu) {
  // BVLC: type 0x81 (BACnet/IP), function 0x0A (Original-Unicast-NPDU), length.
  // NPDU: version 1, control 0x04 for confirmed (expecting reply) else 0x00.
  return { type: 0x0a, apdu };
}

function frame(func, npduControl, apdu) {
  const npdu = Buffer.from([0x01, npduControl]);
  const body = Buffer.concat([npdu, apdu]);
  const len = body.length + 4;
  const bvlc = Buffer.from([0x81, func, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([bvlc, body]);
}

// Skip the NPDU header, honoring the source/destination specifiers a router may
// insert, and return the APDU offset.
function apduOffset(buf) {
  if (buf.length < 6 || buf[0] !== 0x81) return -1;
  let off = 4; // past BVLC
  off += 1; // version
  const control = buf[off++];
  if (control & 0x20) {
    // destination present: DNET(2) DLEN(1) DADR(DLEN)
    off += 2;
    const dlen = buf[off++];
    off += dlen;
  }
  if (control & 0x08) {
    // source present: SNET(2) SLEN(1) SADR(SLEN)
    off += 2;
    const slen = buf[off++];
    off += slen;
  }
  if (control & 0x20) off += 1; // hop count when destination present
  return off;
}

// ---- application-tag reader (ASN.1-style) ----------------------------------
// Returns { tag, isContext, value, next } where value is a Buffer for
// primitive types. Handles extended length (LVT === 5).
function readTag(buf, off) {
  const t = buf[off];
  const tagNumber = (t >> 4) & 0x0f;
  const isContext = (t & 0x08) !== 0;
  let lvt = t & 0x07;
  let p = off + 1;
  if (lvt === 5) {
    lvt = buf[p++]; // extended length (single-byte form is enough here)
  }
  return { tag: tagNumber, isContext, value: buf.subarray(p, p + lvt), next: p + lvt };
}

function uintFromBuf(b) {
  let n = 0;
  for (const byte of b) n = n * 256 + byte;
  return n;
}

// ---- I-Am ------------------------------------------------------------------
function buildWhoIs() {
  // Unconfirmed-Request (0x10) · Who-Is (service 0x08), no range = all devices.
  const apdu = Buffer.from([0x10, 0x08]);
  return frame(bvlcUnicast(apdu).type, 0x00, apdu);
}

function parseIAm(buf) {
  const off = apduOffset(buf);
  if (off < 0 || buf[off] !== 0x10 || buf[off + 1] !== 0x00) return null; // not I-Am
  let p = off + 2;
  // 1) object identifier (application tag 12, 4 bytes)
  const objTag = readTag(buf, p);
  const objId = uintFromBuf(objTag.value);
  p = objTag.next;
  // 2) max APDU length accepted (unsigned)
  const maxTag = readTag(buf, p);
  p = maxTag.next;
  // 3) segmentation supported (enumerated)
  const segTag = readTag(buf, p);
  p = segTag.next;
  // 4) vendor id (unsigned)
  const venTag = readTag(buf, p);

  const segEnum = uintFromBuf(segTag.value);
  const vendorId = uintFromBuf(venTag.value);
  return {
    device_instance: objId & 0x3fffff,
    object_type: objId >>> 22,
    max_apdu: uintFromBuf(maxTag.value),
    segmentation: ['segmented-both', 'segmented-transmit', 'segmented-receive', 'no-segmentation'][segEnum] || `enum ${segEnum}`,
    vendor_id: vendorId,
    vendor_name: VENDOR[vendorId] || `vendor ${vendorId}`,
  };
}

// ---- ReadProperty ----------------------------------------------------------
let invokeCounter = 0;
function buildReadProperty(deviceInstance, propId) {
  const invokeId = invokeCounter++ & 0xff;
  const objId = (OBJECT_TYPE.DEVICE << 22) | (deviceInstance & 0x3fffff);
  const parts = [
    Buffer.from([0x00, 0x05, invokeId, 0x0c]), // confirmed-req, maxseg/apdu, invoke, svc 12
    Buffer.from([0x0c]), // context tag 0 (object id), length 4
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(objId >>> 0, 0);
      return b;
    })(),
    Buffer.from([0x19, propId & 0xff]), // context tag 1 (property id), length 1
  ];
  const apdu = Buffer.concat(parts);
  return { buf: frame(0x0a, 0x04, apdu), invokeId };
}

function parseReadPropertyAck(buf, propName) {
  const off = apduOffset(buf);
  if (off < 0) return { error: 'short-frame' };
  const pduType = buf[off] & 0xf0;
  if (pduType === 0x50) {
    // Error PDU
    return { error: 'bacnet-error' };
  }
  if (pduType !== 0x30) return { error: `unexpected PDU 0x${pduType.toString(16)}` };
  // ComplexACK: 0x30, invoke, service(12), ctx0 objid, ctx1 prop, [3] value [3]
  let p = off + 3;
  // context tag 0 (object id)
  const t0 = readTag(buf, p);
  p = t0.next;
  // context tag 1 (property id)
  const t1 = readTag(buf, p);
  p = t1.next;
  // opening tag 3
  if (buf[p] === 0x3e) p += 1;
  const valTag = readTag(buf, p);
  const raw = valTag.value;
  let value;
  if (propName === 'system-status') {
    const e = uintFromBuf(raw);
    value = SYSTEM_STATUS[e] || `status ${e}`;
  } else if (valTag.tag === 7) {
    // character string: first octet is the encoding, rest are chars
    value = raw.subarray(1).toString('utf8');
  } else if (valTag.tag === 2 || valTag.tag === 9) {
    value = uintFromBuf(raw);
  } else {
    value = raw.toString('latin1');
  }
  return { value };
}

async function whoIs(ctx) {
  const timeout = ctx.params?.timeout ?? 3000;
  const request = buildWhoIs();
  const { data, rttMs } = await udpRequest(ctx.host, ctx.port || 47808, request, { timeout });
  return { request, response: data, iam: parseIAm(data), rttMs };
}

function bytesRaw(req, res) {
  return {
    tx: req ? Buffer.from(req).toString('hex') : null,
    rx: res ? Buffer.from(res).toString('hex') : null,
  };
}

function iamFacts(iam, rttMs, tcpOk = true) {
  return {
    transport: { udp_response: tcpOk ? 'success' : 'none' },
    iam: iam ? { received: true, device_instance: iam.device_instance, vendor_id: iam.vendor_id } : { received: false },
    timeout: false,
    rtt_ms: rttMs,
  };
}

function errorFacts(err) {
  const timeout = err.code === 'ETIMEDOUT';
  return {
    transport: { udp_response: 'none', error: err.code || err.message },
    iam: { received: false },
    timeout,
  };
}

export const verbs = {
  // Identify = unicast Who-Is → I-Am, decoded into the device instance, vendor,
  // and segmentation/APDU capabilities the rest of a BACnet session depends on.
  async identify(ctx) {
    try {
      const r = await whoIs(ctx);
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: bytesRaw(r.request, r.response),
          decode: r.iam,
          result: r.iam
            ? {
                device_instance: r.iam.device_instance,
                vendor: r.iam.vendor_name,
                vendor_id: r.iam.vendor_id,
                max_apdu: r.iam.max_apdu,
                segmentation: r.iam.segmentation,
                rtt_ms: r.rttMs,
              }
            : { iam: null, note: 'response received but not a valid I-Am' },
        }),
        facts: iamFacts(r.iam, r.rttMs),
      };
    } catch (err) {
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: `error: ${err.code || err.message}`,
          result: { iam: null, error: err.code || err.message },
          error: err,
        }),
        facts: errorFacts(err),
      };
    }
  },

  // Read a single device-object property. Defaults to system-status (the health
  // signal); object-name / vendor-name / model-name are character strings.
  async read(ctx) {
    const propName = ctx.params?.property || 'system-status';
    const propId = PROP[propName] ?? PROP['system-status'];
    const timeout = ctx.params?.timeout ?? 3000;
    try {
      // Need the device instance first (from I-Am) to address the ReadProperty.
      const who = await whoIs(ctx);
      if (!who.iam) {
        return {
          artifact: makeArtifact({
            verb: 'read',
            raw: bytesRaw(who.request, who.response),
            result: { error: 'no I-Am — cannot address device object' },
          }),
          facts: iamFacts(null, who.rttMs),
        };
      }
      const { buf } = buildReadProperty(who.iam.device_instance, propId);
      const { data, rttMs } = await udpRequest(ctx.host, ctx.port || 47808, buf, { timeout });
      const parsed = parseReadPropertyAck(data, propName);
      return {
        artifact: makeArtifact({
          verb: 'read',
          raw: bytesRaw(buf, data),
          result: {
            device_instance: who.iam.device_instance,
            property: propName,
            value: parsed.value ?? null,
            error: parsed.error ?? null,
            rtt_ms: rttMs,
          },
        }),
        facts: {
          transport: { udp_response: 'success' },
          iam: { received: true, device_instance: who.iam.device_instance },
          device: { [propName.replace('-', '_')]: parsed.value ?? null },
        },
      };
    } catch (err) {
      return {
        artifact: makeArtifact({ verb: 'read', raw: `error: ${err.code || err.message}`, error: err }),
        facts: errorFacts(err),
      };
    }
  },

  async monitorSample(ctx) {
    try {
      const r = await whoIs(ctx);
      return {
        value: r.rttMs,
        ok: !!r.iam,
        series: { device_instance: r.iam ? r.iam.device_instance : null },
        raw: bytesRaw(r.request, r.response),
      };
    } catch (err) {
      return { value: null, ok: false, raw: `error: ${err.code || err.message}` };
    }
  },

  async diagnose(ctx) {
    try {
      const who = await whoIs(ctx);
      if (!who.iam) {
        return { facts: iamFacts(null, who.rttMs), rulepack: 'bacnet', raw: bytesRaw(who.request, who.response) };
      }
      // Pull system-status so the health verdict has something to judge.
      let systemStatus = null;
      try {
        const { buf } = buildReadProperty(who.iam.device_instance, PROP['system-status']);
        const { data } = await udpRequest(ctx.host, ctx.port || 47808, buf, { timeout: ctx.params?.timeout ?? 3000 });
        systemStatus = parseReadPropertyAck(data, 'system-status').value;
      } catch {
        systemStatus = null;
      }
      return {
        facts: {
          transport: { udp_response: 'success' },
          iam: { received: true, device_instance: who.iam.device_instance, vendor_id: who.iam.vendor_id },
          device: { system_status: systemStatus },
          timeout: false,
          rtt_ms: who.rttMs,
        },
        rulepack: 'bacnet',
        raw: bytesRaw(who.request, who.response),
        decode: { ...who.iam, system_status: systemStatus },
      };
    } catch (err) {
      return { facts: errorFacts(err), rulepack: 'bacnet', raw: `error: ${err.code || err.message}` };
    }
  },
};
