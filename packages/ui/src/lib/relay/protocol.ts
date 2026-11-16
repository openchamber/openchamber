import { z } from 'zod';

export const RELAY_PROTOCOL_VERSION = 1;

const relayRetireSchema = z.object({ type: z.literal('relay-retire'), code: z.number().int(), reason: z.string().catch('') });

export const parseRelayRetire = (raw: string): { code: number; reason: string } | null => {
  try {
    const parsed = relayRetireSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { code: parsed.data.code, reason: parsed.data.reason } : null;
  } catch {
    return null;
  }
};

export const RELAY_HKDF_INFO = 'openchamber-relay-v1';

export const ENCRYPTED_FRAME_VERSION = 1;
export const ENCRYPTED_FRAME_IV_BYTES = 12;
export const ENCRYPTED_FRAME_HEADER_BYTES = 1 + ENCRYPTED_FRAME_IV_BYTES;

export const MAX_PLAINTEXT_FRAME_BYTES = 64 * 1024;

export const TUNNEL_FRAME_HEADER_BYTES = 5;
export const TUNNEL_FRAGMENT_FLAG = 0x80;

export const BATCH_CONTAINER_TAG_SINGLE = 0x00;
export const BATCH_CONTAINER_TAG_BATCH = 0x01;
export const BATCH_FRAME_LENGTH_BYTES = 4;
const BATCH_ENVELOPE_RESERVED_BYTES = 1 + BATCH_FRAME_LENGTH_BYTES;
export const MAX_TUNNEL_PAYLOAD_BYTES =
  MAX_PLAINTEXT_FRAME_BYTES - TUNNEL_FRAME_HEADER_BYTES - BATCH_ENVELOPE_RESERVED_BYTES;

export const TUNNEL_ACCEPT_ENCODING_HEADER = 'x-openchamber-tunnel-accept-encoding';
export const TUNNEL_CONTENT_ENCODING_HEADER = 'x-openchamber-tunnel-content-encoding';

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
  DeliveryAck: 13,
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
  hasBody?: boolean;
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
}

export interface TunnelWsClosePayload {
  code: number;
  reason: string;
}

export interface E2eeHelloMessage {
  t: 'hello';
  v: typeof RELAY_PROTOCOL_VERSION;
  clientPubJwk: JsonWebKey;
  nonce: string;
  batch?: boolean;
  flowControl?: boolean;
}

export interface E2eeReadyMessage {
  t: 'ready';
  v: typeof RELAY_PROTOCOL_VERSION;
  batch?: boolean;
  flowControl?: boolean;
}

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
