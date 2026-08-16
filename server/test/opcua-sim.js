// Minimal OPC UA server simulator for tests and the sim lab. Speaks the UACP
// Hello/Acknowledge handshake and can be told to reject the endpoint URL with a
// UACP Error, so the driver's ack and protocol-error verdicts run end-to-end.
//
// It also answers a SecurityPolicy-None OpenSecureChannel (OPN) and a
// GetEndpoints service call (MSG) with a small endpoint list — one unsecured
// (None) endpoint and one secured (Basic256Sha256 / SignAndEncrypt) — so the
// driver's `browse` verb can enumerate real EndpointDescriptions.

import net from 'node:net';

const SEC_POLICY_NONE = 'http://opcfoundation.org/UA/SecurityPolicy#None';
const SEC_POLICY_B256 = 'http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256';
const TRANSPORT_URI = 'http://opcfoundation.org/UA-Profile/Transport/uatcp-uasc-uabinary';

export function startOpcuaSim({ port = 0, rejectEndpoint = false, errorCode = 0x80830000, serverName = 'Fieldscope OPC UA Sim' } = {}) {
  const server = net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8) {
        const size = pending.readUInt32LE(4);
        if (pending.length < size) break;
        handle(pending.subarray(0, size), socket);
        pending = pending.subarray(size);
      }
    });
    socket.on('error', () => {});
  });

  function handle(frame, socket) {
    const type = frame.toString('latin1', 0, 3);
    if (type === 'HEL') {
      if (rejectEndpoint) socket.write(buildError(errorCode, 'The server does not recognize the endpoint URL.'));
      else socket.write(buildAck());
      return;
    }
    if (type === 'OPN') { socket.write(buildOpn()); return; }
    if (type === 'MSG') { socket.write(buildGetEndpointsResponse(socket, serverName)); return; }
  }

  function buildAck() {
    const body = Buffer.alloc(20);
    body.writeUInt32LE(0, 0); // ProtocolVersion
    body.writeUInt32LE(65536, 4); // ReceiveBufferSize
    body.writeUInt32LE(65536, 8); // SendBufferSize
    body.writeUInt32LE(4 * 1024 * 1024, 12); // MaxMessageSize
    body.writeUInt32LE(64, 16); // MaxChunkCount
    const size = 8 + body.length;
    return Buffer.concat([Buffer.from('ACKF', 'latin1'), u32(size), body]);
  }

  function buildError(code, reason) {
    const reasonBuf = Buffer.from(reason, 'utf8');
    const body = Buffer.alloc(8 + reasonBuf.length);
    body.writeUInt32LE(code >>> 0, 0); // Error (StatusCode)
    body.writeInt32LE(reasonBuf.length, 4); // Reason string length
    reasonBuf.copy(body, 8);
    const size = 8 + body.length;
    return Buffer.concat([Buffer.from('ERRF', 'latin1'), u32(size), body]);
  }

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// OpenSecureChannelResponse (matches opcua.js parseOpn).
function buildOpn() {
  const body = Buffer.concat([
    u32(0x53550001), // SecureChannelId (transport header)
    uaString(SEC_POLICY_NONE),
    byteStringNull(), // SenderCertificate
    byteStringNull(), // ReceiverCertificateThumbprint
    u32(1), u32(1), // SequenceHeader (seq, reqId)
    nodeId4(449), // OpenSecureChannelResponse TypeId
    responseHeader(),
    u32(0), // ServerProtocolVersion
    // SecurityToken: ChannelId, TokenId, CreatedAt, RevisedLifetime
    u32(0x53550001), u32(0x746f6b31), dateTime0(), u32(3600000),
    byteStringNull(), // ServerNonce
  ]);
  return Buffer.concat([Buffer.from('OPNF', 'latin1'), u32(8 + body.length), body]);
}

// GetEndpointsResponse with two endpoints (matches opcua.js parseGetEndpoints).
function buildGetEndpointsResponse(socket, serverName) {
  const url = `opc.tcp://127.0.0.1:${socket.localPort}`;
  const endpoints = [
    endpointDescription(url, serverName, 1 /* None */, SEC_POLICY_NONE, 0),
    endpointDescription(url, serverName, 3 /* SignAndEncrypt */, SEC_POLICY_B256, 3),
  ];
  const body = Buffer.concat([
    u32(0x53550001), u32(0x746f6b31), // SecureChannelId + TokenId
    u32(2), u32(2), // SequenceHeader
    nodeId4(431), // GetEndpointsResponse TypeId
    responseHeader(),
    i32le(endpoints.length),
    ...endpoints,
  ]);
  return Buffer.concat([Buffer.from('MSGF', 'latin1'), u32(8 + body.length), body]);
}

function endpointDescription(url, serverName, mode, policyUri, level) {
  return Buffer.concat([
    uaString(url), // EndpointUrl
    uaString(`urn:fieldscope:${serverName}`), // ApplicationUri
    uaString('urn:fieldscope:product'), // ProductUri
    localizedText(serverName), // ApplicationName
    u32(0), // ApplicationType: Server
    uaString(null), // GatewayServerUri
    uaString(null), // DiscoveryProfileUri
    i32le(1), uaString(url), // DiscoveryUrls
    byteStringNull(), // ServerCertificate
    u32(mode), // SecurityMode
    uaString(policyUri), // SecurityPolicyUri
    i32le(1), userTokenPolicy(), // UserIdentityTokens (one anonymous)
    uaString(TRANSPORT_URI), // TransportProfileUri
    u8(level), // SecurityLevel
  ]);
}

// UserTokenPolicy: PolicyId, TokenType, IssuedTokenType, IssuerEndpointUrl, SecurityPolicyUri
function userTokenPolicy() {
  return Buffer.concat([
    uaString('anonymous'),
    u32(0), // TokenType: Anonymous
    uaString(null),
    uaString(null),
    uaString(null),
  ]);
}

// ResponseHeader: timestamp, requestHandle, serviceResult, diagnostics,
// stringTable(-1), additionalHeader(null ExtensionObject).
function responseHeader() {
  return Buffer.concat([dateTime0(), u32(0), u32(0), u8(0), i32le(-1), nodeIdNull(), u8(0)]);
}

function localizedText(text) {
  return Buffer.concat([u8(0x02), uaString(text)]); // encoding: text present
}

function u8(n) { return Buffer.from([n & 0xff]); }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function i32le(n) { const b = Buffer.alloc(4); b.writeInt32LE(n, 0); return b; }
const byteStringNull = () => i32le(-1);
const nodeId4 = (id) => Buffer.concat([u8(0x01), u8(0x00), u16le(id)]);
const nodeIdNull = () => Buffer.from([0x00, 0x00]);
const dateTime0 = () => Buffer.alloc(8);
function u16le(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function uaString(s) {
  if (s == null) { const b = Buffer.alloc(4); b.writeInt32LE(-1, 0); return b; }
  const body = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4); len.writeInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}
