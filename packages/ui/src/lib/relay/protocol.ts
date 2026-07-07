// OpenChamber private relay protocol constants and shared types.
// Spec: .opencode/plans/private-relay/01-protocol-spec.md
// Three layers: relay routing (Layer 1), E2EE channel (Layer 2), tunnel mux (Layer 3).
// This module is isomorphic: browser, Node, and Cloudflare Workers.

export const RELAY_PROTOCOL_VERSION = 1;

export const RELAY_HKDF_INFO = 'openchamber-relay-v1';

// Encrypted frame layout: [1 byte version][12 byte IV][ciphertext + 16 byte GCM tag].
export const ENCRYPTED_FRAME_VERSION = 1;
export const ENCRYPTED_FRAME_IV_BYTES = 12;
export const ENCRYPTED_FRAME_HEADER_BYTES = 1 + ENCRYPTED_FRAME_IV_BYTES;

// Max plaintext per encrypted frame. Keeps relay-forwarded WS messages far
// below Cloudflare's 1 MiB cap even after GCM tag + header overhead.
export const MAX_PLAINTEXT_FRAME_BYTES = 64 * 1024;

// Tunnel frame layout: [1 byte frameType(+fragment flag)][4 byte BE streamId][payload].
export const TUNNEL_FRAME_HEADER_BYTES = 5;
export const TUNNEL_FRAGMENT_FLAG = 0x80;

// Batch envelope (Layer 2 plaintext container, used only when both peers
// negotiated `batch`). Plaintext = [1 byte container tag] then either the raw
// tunnel frame (tag 0x00) or repeated [4 byte BE length][frame] (tag 0x01).
// See tunnel-codec encodeFrameBatch/decodeFrameBatch.
export const BATCH_CONTAINER_TAG_SINGLE = 0x00;
export const BATCH_CONTAINER_TAG_BATCH = 0x01;
export const BATCH_FRAME_LENGTH_BYTES = 4;
// Worst-case per-frame envelope overhead inside a batch (tag + length prefix).
// Reserved from the tunnel payload budget so any single frame — even at the
// maximum size — still fits inside one 64 KiB encrypted plaintext once wrapped.
export const BATCH_ENVELOPE_RESERVED_BYTES = 1 + BATCH_FRAME_LENGTH_BYTES;
export const MAX_TUNNEL_PAYLOAD_BYTES =
  MAX_PLAINTEXT_FRAME_BYTES - TUNNEL_FRAME_HEADER_BYTES - BATCH_ENVELOPE_RESERVED_BYTES;

export const TunnelFrameType = {
  HttpRequest: 1,
  HttpBody: 2,
  HttpResponse: 3,
  StreamEnd: 4,
  StreamAbort: 5,
  WsOpen: 6,
  WsOpened: 7,
  WsText: 8,
  WsBinary: 9,
  WsClose: 10,
  Ping: 11,
  Pong: 12,
} as const;

export type TunnelFrameTypeValue = (typeof TunnelFrameType)[keyof typeof TunnelFrameType];

const TUNNEL_FRAME_TYPE_VALUES = new Set<number>(Object.values(TunnelFrameType));

export const isTunnelFrameType = (value: number): value is TunnelFrameTypeValue =>
  TUNNEL_FRAME_TYPE_VALUES.has(value);

export interface TunnelHttpRequestPayload {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
}

export interface TunnelHttpResponsePayload {
  status: number;
  headers: Record<string, string>;
}

export interface TunnelStreamAbortPayload {
  reason: string;
}

export interface TunnelWsOpenPayload {
  path: string;
  query: string;
  protocols?: string[];
  // The client's real page origin (e.g. capacitor://localhost, openchamber-ui://app).
  // The host sets it as the Origin header on the loopback dial so the server's WS
  // origin check accepts it — the tunnel drops browser-set headers otherwise, and
  // a WS upgrade with no Origin is rejected.
  origin?: string;
}

export interface TunnelWsOpenedPayload {
  protocol?: string;
}

export interface TunnelWsClosePayload {
  code: number;
  reason: string;
}

// Layer 2 handshake messages (plaintext JSON text frames, before encryption starts).
export interface E2eeHelloMessage {
  t: 'hello';
  v: typeof RELAY_PROTOCOL_VERSION;
  clientPubJwk: JsonWebKey;
  nonce: string; // base64url, 16 bytes
  // Capability advertisement: the client can pack multiple tunnel frames into
  // one encrypted WS message. Missing/false = legacy (one frame per message).
  batch?: boolean;
}

export interface E2eeReadyMessage {
  t: 'ready';
  v: typeof RELAY_PROTOCOL_VERSION;
  // Host echoes `batch: true` only when it also supports batching AND the client
  // advertised it. Batching is enabled for the session only if both agree.
  batch?: boolean;
}

// Layer 1 control messages (relay <-> host control socket).
export type RelayControlMessage =
  | { type: 'sync'; connectionIds: string[] }
  | { type: 'connected'; connectionId: string }
  | { type: 'disconnected'; connectionId: string }
  | { type: 'limit'; reason: string };

// Relay-assigned WebSocket close codes.
export const RelayCloseCode = {
  ControlReplaced: 4001,
  DuplicateClient: 4002,
  StuckControlReset: 4003,
  HostUnavailable: 4008,
  AuthFailed: 4010,
  LimitExceeded: 4029,
  HostWentAway: 1012,
  RekeyMismatch: 1008,
  ChannelFailure: 1011,
} as const;

// Pairing payload carried in QR / deep-link URL fragments only.
export interface RelayOfferV1 {
  v: 1;
  mode: 'relay';
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
  label?: string;
  token?: string;
  grant?: string;
}
