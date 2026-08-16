// OPC UA driver (§6.4, §12 phase 5). The flagship IIoT interoperability
// protocol. Full OPC UA is a large binary stack (secure channel, session,
// browse, subscribe); this driver implements the OPC UA Connection Protocol
// (UACP) Hello/Acknowledge handshake — the transport tier that every OPC UA
// session begins with — plus Error-message decode.
//
// That handshake answers real field questions on its own: is there actually an
// OPC UA binary server on opc.tcp (not just an open port), does it accept this
// endpoint URL, and what message/chunk limits does it negotiate? A rejected
// endpoint URL or an unsupported protocol version comes back as a UACP Error
// with a decodable StatusCode — exactly the "why won't my client connect"
// signal. Deeper endpoint/security-policy and cert-chain audit (GetEndpoints
// over a secure channel) is the natural next layer on top of this transport.

import { tcpConnect, tcpRequest } from '../transport/transport.js';
import { makeArtifact } from '../contract/contract.js';

export const manifest = {
  id: 'opcua',
  display_name: 'OPC UA',
  domain: 'iiot',
  group: 'iiot',
  transport: ['tcp'],
  default_port: 4840,
  mode: 'full',
  lib: '🟢 raw UACP + GetEndpoints',
  describe:
    'OPC UA binary: Hello/Acknowledge handshake (endpoint liveness, buffer/chunk negotiation, decoded protocol errors) plus OpenSecureChannel + GetEndpoints endpoint/security-policy enumeration.',
  verbs: ['connect', 'identify', 'browse', 'monitor', 'diagnose'],
  params: {
    connect: { endpoint_url: { type: 'string' } },
    identify: { endpoint_url: { type: 'string' } },
    browse: { endpoint_url: { type: 'string' }, timeout: { type: 'number', min: 500, max: 30000 } },
  },
};

// A subset of OPC UA StatusCodes relevant to the UACP handshake (Part 6 / Part 4).
const STATUS_TEXT = {
  0x80830000: 'Bad_TcpEndpointUrlInvalid — the server rejected the endpoint URL',
  0x807e0000: 'Bad_TcpMessageTypeInvalid',
  0x807f0000: 'Bad_TcpSecureChannelUnknown',
  0x80800000: 'Bad_TcpMessageTooLarge',
  0x80810000: 'Bad_TcpNotEnoughResources',
  0x80820000: 'Bad_TcpInternalError',
  0x80840000: 'Bad_TcpServerTooBusy',
  0x807d0000: 'Bad_TcpProtocolVersionUnsupported',
};

function statusText(code) {
  return STATUS_TEXT[code >>> 0] || `0x${(code >>> 0).toString(16).padStart(8, '0')}`;
}

// Short display name for a SecurityPolicy URI (…/SecurityPolicy#Basic256Sha256).
function policyShort(uri) {
  if (!uri) return null;
  const hash = uri.lastIndexOf('#');
  return hash >= 0 ? uri.slice(hash + 1) : uri;
}

// UACP string: int32 length (LE), then UTF-8 bytes. -1 length = null.
function uaString(s) {
  if (s == null) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(-1, 0);
    return b;
  }
  const body = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}

function readUaString(buf, off) {
  const len = buf.readInt32LE(off);
  if (len < 0) return { value: null, next: off + 4 };
  return { value: buf.subarray(off + 4, off + 4 + len).toString('utf8'), next: off + 4 + len };
}

// Build a HEL (Hello) message. MessageType(3)+ChunkType(1)+MessageSize(4) header.
function buildHello(endpointUrl) {
  const body = Buffer.concat([
    u32(0), // ProtocolVersion
    u32(65536), // ReceiveBufferSize
    u32(65536), // SendBufferSize
    u32(0), // MaxMessageSize (0 = no limit)
    u32(0), // MaxChunkCount (0 = no limit)
    uaString(endpointUrl),
  ]);
  const size = 8 + body.length;
  const header = Buffer.concat([Buffer.from('HELF', 'latin1'), u32(size)]);
  return Buffer.concat([header, body]);
}

function messageComplete(buf) {
  if (buf.length < 8) return false;
  return buf.length >= buf.readUInt32LE(4);
}

function parseResponse(buf) {
  if (buf.length < 8) return { error: 'short-frame' };
  const type = buf.toString('latin1', 0, 3);
  const size = buf.readUInt32LE(4);
  if (type === 'ACK') {
    return {
      type,
      ack: {
        protocol_version: buf.readUInt32LE(8),
        receive_buffer: buf.readUInt32LE(12),
        send_buffer: buf.readUInt32LE(16),
        max_message_size: buf.readUInt32LE(20),
        max_chunk_count: buf.readUInt32LE(24),
      },
    };
  }
  if (type === 'ERR') {
    const code = buf.readUInt32LE(8);
    const reason = readUaString(buf, 12).value;
    return { type, error_code: code, error_text: statusText(code), reason };
  }
  return { type, size, note: 'unexpected UACP message type' };
}

// ---- OPC UA binary encoding helpers (Part 6) --------------------------------
const SEC_POLICY_NONE = 'http://opcfoundation.org/UA/SecurityPolicy#None';
const SEC_MODE = ['Invalid', 'None', 'Sign', 'SignAndEncrypt'];

function u8(n) { return Buffer.from([n & 0xff]); }
function u16le(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function i32le(n) { const b = Buffer.alloc(4); b.writeInt32LE(n, 0); return b; }
const byteStringNull = () => i32le(-1);
const nodeId4 = (id) => Buffer.concat([u8(0x01), u8(0x00), u16le(id)]); // FourByteNodeId, ns 0
const nodeIdNull = () => Buffer.from([0x00, 0x00]); // TwoByteNodeId id 0
const dateTime0 = () => Buffer.alloc(8);
const extObjNull = () => Buffer.concat([nodeIdNull(), u8(0x00)]); // typeId null + encoding None

function readByteString(buf, off) {
  const len = buf.readInt32LE(off);
  if (len < 0) return { next: off + 4, value: null };
  return { next: off + 4 + len, value: buf.subarray(off + 4, off + 4 + len) };
}

// RequestHeader: null auth token, timestamp, handle, diags, audit id, timeout, ext.
function requestHeader(handle, timeoutMs = 10000) {
  return Buffer.concat([nodeIdNull(), dateTime0(), u32(handle), u32(0), uaString(null), u32(timeoutMs), extObjNull()]);
}

// OPN (OpenSecureChannel) request with SecurityPolicy None.
function buildOpn(seq, requestId) {
  const svc = Buffer.concat([
    requestHeader(requestId),
    u32(0), // ClientProtocolVersion
    u32(0), // RequestType: Issue
    u32(1), // SecurityMode: None
    byteStringNull(), // ClientNonce
    u32(3600000), // RequestedLifetime
  ]);
  const body = Buffer.concat([
    u32(0), // SecureChannelId (0 = new)
    uaString(SEC_POLICY_NONE),
    byteStringNull(), // SenderCertificate
    byteStringNull(), // ReceiverCertificateThumbprint
    u32(seq), u32(requestId), // SequenceHeader
    nodeId4(446), // OpenSecureChannelRequest TypeId
    svc,
  ]);
  return Buffer.concat([Buffer.from('OPNF', 'latin1'), u32(8 + body.length), body]);
}

function parseOpn(buf) {
  let o = 8;
  o += 4; // SecureChannelId (of the transport header, ignore)
  o = readUaString(buf, o).next; // SecurityPolicyUri
  o = readByteString(buf, o).next; // SenderCertificate
  o = readByteString(buf, o).next; // ReceiverCertificateThumbprint
  o += 8; // SequenceHeader
  o += 4; // TypeId (FourByteNodeId, OpenSecureChannelResponse)
  o += 8 + 4; // ResponseHeader: timestamp + requestHandle
  const serviceResult = buf.readUInt32LE(o); o += 4;
  o += 1; // ServiceDiagnostics (encoding byte)
  o += 4; // StringTable array length (-1)
  o += 3; // AdditionalHeader ExtensionObject
  o += 4; // ServerProtocolVersion
  const secureChannelId = buf.readUInt32LE(o); o += 4;
  const tokenId = buf.readUInt32LE(o); o += 4;
  return { secureChannelId, tokenId, serviceResult };
}

// MSG carrying a GetEndpoints service request on the open secure channel.
function buildGetEndpoints(channelId, tokenId, seq, requestId, endpointUrl) {
  const body = Buffer.concat([
    u32(channelId), u32(tokenId),
    u32(seq), u32(requestId),
    nodeId4(428), // GetEndpointsRequest TypeId
    requestHeader(requestId),
    uaString(endpointUrl),
    i32le(-1), // LocaleIds (null array)
    i32le(-1), // ProfileUris (null array)
  ]);
  return Buffer.concat([Buffer.from('MSGF', 'latin1'), u32(8 + body.length), body]);
}

function parseGetEndpoints(buf) {
  let o = 8;
  o += 4 + 4; // SecureChannelId + TokenId
  o += 8; // SequenceHeader
  o += 4; // TypeId (GetEndpointsResponse)
  o += 8 + 4; // ResponseHeader timestamp + requestHandle
  const serviceResult = buf.readUInt32LE(o); o += 4;
  o += 1 + 4 + 3; // ServiceDiagnostics + StringTable(-1) + AdditionalHeader
  const count = buf.readInt32LE(o); o += 4;
  const endpoints = [];
  for (let i = 0; i < count && i < 50; i++) {
    const ep = {};
    let s = readUaString(buf, o); ep.endpoint_url = s.value; o = s.next;
    s = readUaString(buf, o); ep.server_uri = s.value; o = s.next; // ApplicationUri
    o = readUaString(buf, o).next; // ProductUri
    const enc = buf[o]; o += 1; // ApplicationName LocalizedText
    if (enc & 0x01) o = readUaString(buf, o).next; // locale
    if (enc & 0x02) { s = readUaString(buf, o); ep.server_name = s.value; o = s.next; } // text
    o += 4; // ApplicationType
    o = readUaString(buf, o).next; // GatewayServerUri
    o = readUaString(buf, o).next; // DiscoveryProfileUri
    const dcount = buf.readInt32LE(o); o += 4; // DiscoveryUrls
    for (let j = 0; j < dcount; j++) o = readUaString(buf, o).next;
    o = readByteString(buf, o).next; // ServerCertificate
    ep.security_mode = SEC_MODE[buf.readUInt32LE(o)] || buf.readUInt32LE(o); o += 4;
    s = readUaString(buf, o); ep.security_policy = s.value; o = s.next;
    const ucount = buf.readInt32LE(o); o += 4; // UserIdentityTokens
    for (let j = 0; j < ucount; j++) {
      o = readUaString(buf, o).next; // PolicyId
      o += 4; // TokenType
      o = readUaString(buf, o).next; // IssuedTokenType
      o = readUaString(buf, o).next; // IssuerEndpointUrl
      o = readUaString(buf, o).next; // SecurityPolicyUri
    }
    s = readUaString(buf, o); ep.transport_profile = s.value; o = s.next;
    ep.security_level = buf[o]; o += 1;
    endpoints.push(ep);
  }
  return { serviceResult, endpoints };
}

// HEL/ACK → OPN → GetEndpoints, all on one connection.
async function getEndpoints(ctx) {
  const timeout = ctx.params?.timeout ?? 3000;
  const port = ctx.port || 4840;
  const endpointUrl = ctx.params?.endpoint_url || `opc.tcp://${ctx.host}:${port}`;
  const { socket } = await tcpConnect(ctx.host, port, timeout);
  try {
    const { data: ack } = await tcpRequest(socket, buildHello(endpointUrl), { timeout, isComplete: messageComplete });
    if (ack.toString('latin1', 0, 3) !== 'ACK') return { stage: 'hello', parsed: parseResponse(ack), endpointUrl };
    const { data: opnResp } = await tcpRequest(socket, buildOpn(1, 1), { timeout, isComplete: messageComplete });
    if (opnResp.toString('latin1', 0, 3) !== 'OPN') return { stage: 'opn', parsed: parseResponse(opnResp), endpointUrl };
    const chan = parseOpn(opnResp);
    const { data: geResp, rttMs } = await tcpRequest(socket, buildGetEndpoints(chan.secureChannelId, chan.tokenId, 2, 2, endpointUrl), { timeout, isComplete: messageComplete });
    if (geResp.toString('latin1', 0, 3) !== 'MSG') return { stage: 'getendpoints', parsed: parseResponse(geResp), endpointUrl };
    return { stage: 'ok', ...parseGetEndpoints(geResp), endpointUrl, rttMs };
  } finally {
    socket.destroy();
  }
}

async function handshake(ctx) {
  const timeout = ctx.params?.timeout ?? 3000;
  const port = ctx.port || 4840;
  const endpointUrl = ctx.params?.endpoint_url || `opc.tcp://${ctx.host}:${port}`;
  const { socket, connectMs } = await tcpConnect(ctx.host, port, timeout);
  try {
    const hello = buildHello(endpointUrl);
    const { data, rttMs } = await tcpRequest(socket, hello, { timeout, isComplete: messageComplete });
    return { request: hello, response: data, parsed: parseResponse(data), endpointUrl, connectMs, rttMs };
  } finally {
    socket.destroy();
  }
}

function bytesRaw(req, res) {
  return {
    tx: req ? Buffer.from(req).toString('hex') : null,
    rx: res ? Buffer.from(res).toString('hex') : null,
  };
}

function facts(parsed, rttMs) {
  return {
    transport: { tcp_connect: 'success' },
    uacp: {
      ack: parsed.type === 'ACK',
      error: parsed.type === 'ERR' ? parsed.error_text : null,
      type: parsed.type,
    },
    timeout: false,
    rtt_ms: rttMs,
  };
}

function errorFacts(err) {
  const timeout = err.code === 'ETIMEDOUT';
  return {
    transport: { tcp_connect: timeout ? 'success' : 'fail', error: err.code || err.message },
    uacp: { ack: false, type: null },
    timeout,
  };
}

export const verbs = {
  async connect(ctx) {
    try {
      const r = await handshake(ctx);
      const ok = r.parsed.type === 'ACK';
      return {
        artifact: makeArtifact({
          verb: 'connect',
          raw: bytesRaw(r.request, r.response),
          decode: r.parsed,
          result: {
            handshake: ok ? 'acknowledged' : r.parsed.type,
            endpoint_url: r.endpointUrl,
            negotiated: ok ? r.parsed.ack : null,
            error: r.parsed.type === 'ERR' ? `${r.parsed.error_text}${r.parsed.reason ? ` — ${r.parsed.reason}` : ''}` : null,
            rtt_ms: r.rttMs,
          },
        }),
        facts: facts(r.parsed, r.rttMs),
      };
    } catch (err) {
      return {
        artifact: makeArtifact({
          verb: 'connect',
          raw: `error: ${err.code || err.message}`,
          result: { handshake: 'failed', error: err.code || err.message },
          error: err,
        }),
        facts: errorFacts(err),
      };
    }
  },

  // Identify surfaces the negotiated transport limits — the server's declared
  // receive/send buffers and message/chunk caps.
  async identify(ctx) {
    try {
      const r = await handshake(ctx);
      if (r.parsed.type !== 'ACK') {
        return {
          artifact: makeArtifact({
            verb: 'identify',
            raw: bytesRaw(r.request, r.response),
            decode: r.parsed,
            result: { acknowledged: false, response: r.parsed.type, error: r.parsed.error_text || null, reason: r.parsed.reason || null },
          }),
          facts: facts(r.parsed, r.rttMs),
        };
      }
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: bytesRaw(r.request, r.response),
          decode: r.parsed.ack,
          result: {
            acknowledged: true,
            endpoint_url: r.endpointUrl,
            receive_buffer: r.parsed.ack.receive_buffer,
            send_buffer: r.parsed.ack.send_buffer,
            max_message_size: r.parsed.ack.max_message_size || 'unlimited',
            max_chunk_count: r.parsed.ack.max_chunk_count || 'unlimited',
            rtt_ms: r.rttMs,
          },
        }),
        facts: facts(r.parsed, r.rttMs),
      };
    } catch (err) {
      return {
        artifact: makeArtifact({
          verb: 'identify',
          raw: `error: ${err.code || err.message}`,
          result: { acknowledged: false, error: err.code || err.message },
          error: err,
        }),
        facts: errorFacts(err),
      };
    }
  },

  // Browse opens a secure channel (SecurityPolicy None) and runs GetEndpoints,
  // enumerating the security modes / policies the server actually offers — the
  // "which endpoint should my client connect to, and does it require certs"
  // question, and the entry point to a real cert-chain / policy audit.
  async browse(ctx) {
    try {
      const r = await getEndpoints(ctx);
      if (r.stage !== 'ok') {
        const p = r.parsed || {};
        return {
          artifact: makeArtifact({
            verb: 'browse',
            raw: JSON.stringify(r, null, 2),
            decode: p,
            result: {
              endpoint_url: r.endpointUrl,
              endpoints: 0,
              stalled_at: r.stage,
              response: p.type || null,
              error: p.error_text ? `${p.error_text}${p.reason ? ` — ${p.reason}` : ''}` : null,
            },
          }),
          facts: { transport: { tcp_connect: 'success' }, uacp: { ack: r.stage !== 'hello' }, getendpoints: { ok: false, stage: r.stage }, timeout: false },
        };
      }
      const point = (ep, i) => ({
        ref: ep.endpoint_url || `endpoint[${i}]`,
        value: `${ep.security_mode} · level ${ep.security_level}`,
        type: policyShort(ep.security_policy),
      });
      const unsecuredEps = r.endpoints.filter((e) => e.security_mode === 'None');
      const securedEps = r.endpoints.filter((e) => e.security_mode !== 'None');
      const tree = [];
      if (unsecuredEps.length) tree.push({ area: 'No security (None)', points: unsecuredEps.map(point) });
      if (securedEps.length) tree.push({ area: 'Secured (Sign / SignAndEncrypt)', points: securedEps.map(point) });
      const secured = securedEps.length;
      return {
        artifact: makeArtifact({
          verb: 'browse',
          raw: JSON.stringify(r, null, 2),
          result: {
            endpoint_url: r.endpointUrl,
            server_name: r.endpoints.find((e) => e.server_name)?.server_name || null,
            endpoints: r.endpoints.length,
            secured,
            unsecured: r.endpoints.length - secured,
            rtt_ms: r.rttMs,
            tree,
          },
        }),
        facts: {
          transport: { tcp_connect: 'success' },
          uacp: { ack: true },
          getendpoints: { ok: true, service_result: r.serviceResult, count: r.endpoints.length, secured, unsecured: r.endpoints.length - secured },
          timeout: false,
          rtt_ms: r.rttMs,
        },
      };
    } catch (err) {
      return {
        artifact: makeArtifact({
          verb: 'browse',
          raw: `error: ${err.code || err.message}`,
          result: { endpoints: 0, error: err.code || err.message },
          error: err,
        }),
        facts: { ...errorFacts(err), getendpoints: { ok: false } },
      };
    }
  },

  async monitorSample(ctx) {
    try {
      const r = await handshake(ctx);
      return { value: r.rttMs, ok: r.parsed.type === 'ACK', raw: bytesRaw(r.request, r.response) };
    } catch (err) {
      return { value: null, ok: false, raw: `error: ${err.code || err.message}` };
    }
  },

  async diagnose(ctx) {
    try {
      const r = await handshake(ctx);
      return { facts: facts(r.parsed, r.rttMs), rulepack: 'opcua', raw: bytesRaw(r.request, r.response), decode: r.parsed };
    } catch (err) {
      return { facts: errorFacts(err), rulepack: 'opcua', raw: `error: ${err.code || err.message}` };
    }
  },
};

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

export { buildHello, parseResponse };
