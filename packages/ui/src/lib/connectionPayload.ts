import { z } from 'zod';

const MAX_PAIRING_PAYLOAD_LENGTH = 16_384;

// A pairing candidate is one way to reach the host's HTTP API. `type`
// discriminates the transport:
//   - lan / tunnel: reach `url` directly (health-check, then redeem over fetch).
//   - relay: no reachable URL — open the E2EE relay tunnel to `serverId` via
//     `relayUrl`, trusting `hostEncPubJwk`, then redeem over the tunnel.
// The one-time pairing `secret` (payload level) is the single auth credential,
// redeemed over whichever transport connects first. Relay carries no embedded
// bearer token — that is the v1 sin this format replaces.
type PairingDirectCandidate = {
  type: 'lan' | 'tunnel';
  url: string;
  priority?: number;
};

type PairingRelayCandidate = {
  type: 'relay';
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
  // One-time relay-infrastructure authorization. Reserved: the v1 relay worker
  // ignores it (E2EE + the pairing secret are the actual gates). Plumbed for
  // future relay-side per-device/traffic control. Never persisted.
  grant?: string;
  priority?: number;
};

export type PairingEndpointCandidate = PairingDirectCandidate | PairingRelayCandidate;

export type PairingConnectionPayload = {
  v: 2;
  pairingId: string;
  secret: string;
  label?: string;
  fingerprint?: string;
  expiresAt?: string;
  candidates: PairingEndpointCandidate[];
  // Extra request headers the instance sits behind (auth proxy). Sent with the
  // redeem call and stored as the host's `requestHeaders`. A base64url link is
  // readable by anyone holding it, so these are as sensitive as the secret.
  headers?: Record<string, string>;
};

// Mirrors what a stored host accepts (see desktopHosts sanitizeRequestHeaders):
// `authorization` stays reserved for the runtime's own bearer token.
const MAX_PAIRING_HEADERS = 16;
const MAX_PAIRING_HEADER_NAME_LENGTH = 128;
const MAX_PAIRING_HEADER_VALUE_LENGTH = 1024;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE_PATTERN = /^[\t\x20-\x7e]+$/;

// The map comes out of an untrusted link, so it is decoded whole: one bad name,
// value or an oversized map drops the map instead of half-applying a proxy
// setup that could not work anyway.
const pairingHeadersSchema = z
  .record(
    z.string()
      .trim()
      .min(1)
      .max(MAX_PAIRING_HEADER_NAME_LENGTH)
      .regex(HEADER_NAME_PATTERN)
      .refine((name) => name.toLowerCase() !== 'authorization'),
    z.string().trim().min(1).max(MAX_PAIRING_HEADER_VALUE_LENGTH).regex(HEADER_VALUE_PATTERN),
  )
  .refine((headers) => Object.keys(headers).length <= MAX_PAIRING_HEADERS);

const normalizePairingHeaders = (value: Record<string, string> | undefined): Record<string, string> | undefined => {
  const parsed = pairingHeadersSchema.safeParse(value);
  return parsed.success && Object.keys(parsed.data).length > 0 ? parsed.data : undefined;
};

const globalWithBuffer = globalThis as typeof globalThis & {
  Buffer?: {
    from: (value: string, encoding?: string) => { toString: (encoding: string) => string };
  };
};

const base64UrlEncode = (value: string): string => {
  if (globalWithBuffer.Buffer) {
    return globalWithBuffer.Buffer.from(value, 'utf8').toString('base64url');
  }
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlDecode = (value: string): string | null => {
  try {
    if (globalWithBuffer.Buffer) {
      return globalWithBuffer.Buffer.from(value, 'base64url').toString('utf8');
    }
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
};

const normalizeHttpUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/g, '');
  } catch {
    return null;
  }
};

// Relay endpoints are WebSocket URLs and keep their path (e.g. `/ws`, `/tunnel`),
// so only the fragment is stripped — never the trailing path segment.
const normalizeWsUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

// EC P-256 public JWK (the relay E2EE trust anchor). Strict: only the four
// public-key members are retained; a private `d` or any other member is dropped.
const normalizeEcPublicJwk = (value: unknown): JsonWebKey | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const jwk = value as Record<string, unknown>;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
  if (!isNonEmptyString(jwk.x) || !isNonEmptyString(jwk.y)) return null;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
};

const normalizePriority = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const normalizePairingCandidate = (value: unknown): PairingEndpointCandidate | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const priority = normalizePriority(record.priority);

  if (record.type === 'lan' || record.type === 'tunnel') {
    const url = normalizeHttpUrl(record.url);
    if (!url) return null;
    return priority === undefined ? { type: record.type, url } : { type: record.type, url, priority };
  }

  if (record.type === 'relay') {
    const relayUrl = normalizeWsUrl(record.relayUrl);
    if (!relayUrl) return null;
    const serverId = typeof record.serverId === 'string' ? record.serverId.trim() : '';
    if (!serverId) return null;
    const hostEncPubJwk = normalizeEcPublicJwk(record.hostEncPubJwk);
    if (!hostEncPubJwk) return null;
    const grant = typeof record.grant === 'string' && record.grant.trim() ? record.grant.trim() : undefined;
    return {
      type: 'relay',
      relayUrl,
      serverId,
      hostEncPubJwk,
      ...(grant ? { grant } : {}),
      ...(priority === undefined ? {} : { priority }),
    };
  }

  return null;
};

const normalizePairingPayload = (value: unknown): PairingConnectionPayload | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 2) return null;
  const pairingId = typeof record.pairingId === 'string' ? record.pairingId.trim() : '';
  const secret = typeof record.secret === 'string' ? record.secret.trim() : '';
  if (!pairingId || !secret) return null;
  const candidates = Array.isArray(record.candidates)
    ? record.candidates.map(normalizePairingCandidate).filter((candidate): candidate is PairingEndpointCandidate => Boolean(candidate))
    : [];
  if (candidates.length === 0) return null;
  const expiresAt = typeof record.expiresAt === 'string' && record.expiresAt.trim() ? record.expiresAt.trim() : undefined;
  if (expiresAt) {
    const expiresTime = Date.parse(expiresAt);
    if (!Number.isFinite(expiresTime) || expiresTime <= Date.now()) return null;
  }
  const label = typeof record.label === 'string' && record.label.trim() ? record.label.trim() : undefined;
  const fingerprint = typeof record.fingerprint === 'string' && record.fingerprint.trim() ? record.fingerprint.trim() : undefined;
  const headersField = pairingHeadersSchema.safeParse(record.headers);
  const payload: PairingConnectionPayload = { v: 2, pairingId, secret, candidates };
  if (label) payload.label = label;
  if (fingerprint) payload.fingerprint = fingerprint;
  if (expiresAt) payload.expiresAt = expiresAt;
  if (headersField.success && Object.keys(headersField.data).length > 0) payload.headers = headersField.data;
  return payload;
};

export const buildPairingConnectionPayload = (input: Omit<PairingConnectionPayload, 'v'>): PairingConnectionPayload => {
  const payload: PairingConnectionPayload = {
    v: 2,
    pairingId: input.pairingId.trim(),
    secret: input.secret.trim(),
    candidates: input.candidates,
  };
  if (input.label?.trim()) payload.label = input.label.trim();
  if (input.fingerprint?.trim()) payload.fingerprint = input.fingerprint.trim();
  if (input.expiresAt?.trim()) payload.expiresAt = input.expiresAt.trim();
  const headers = normalizePairingHeaders(input.headers);
  if (headers) payload.headers = headers;
  return payload;
};

export const encodePairingConnectionPayload = (payload: PairingConnectionPayload): string => {
  const normalized = normalizePairingPayload(payload);
  if (!normalized) throw new Error('Invalid pairing connection payload');
  const params = new URLSearchParams();
  params.set('v', '2');
  params.set('p', base64UrlEncode(JSON.stringify(normalized)));
  return `openchamber://connect?${params.toString()}`;
};

export const parsePairingConnectionPayload = (value: string): PairingConnectionPayload | null => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PAIRING_PAYLOAD_LENGTH) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'openchamber:' || url.hostname !== 'connect') return null;
    if (url.searchParams.get('v') !== '2') return null;
    const encoded = url.searchParams.get('p') || '';
    if (!encoded || encoded.length > MAX_PAIRING_PAYLOAD_LENGTH) return null;
    const decoded = base64UrlDecode(encoded);
    if (!decoded || decoded.length > MAX_PAIRING_PAYLOAD_LENGTH) return null;
    return normalizePairingPayload(JSON.parse(decoded) as unknown);
  } catch {
    return null;
  }
};

// URL-string-only sibling of parsePairingConnectionPayload. Old Android WebViews
// (e.g. WebView 114) mis-parse non-special schemes: `new URL('openchamber://connect?...')`
// yields hostname "" and pathname "//connect", so the URL-based parser above rejects a
// perfectly valid pairing link. This parser never touches the URL/URLSearchParams APIs —
// it matches the head with a regex and reads `v`/`p` straight off the query string.
// Used by the mobile scan and paste paths after the standard parse fails; keeps every existing
// validation (version, payload length, base64url, candidate normalization).
export const parsePairingConnectionPayloadString = (value: string): PairingConnectionPayload | null => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PAIRING_PAYLOAD_LENGTH) return null;
  const question = trimmed.indexOf('?');
  if (question === -1 || !/^openchamber:\/\/connect\/?$/i.test(trimmed.slice(0, question))) return null;
  let version: string | null = null;
  let encoded: string | null = null;
  for (const part of trimmed.slice(question + 1).split('&')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value_ = part.slice(eq + 1);
    if (key === 'v') version = value_;
    else if (key === 'p') encoded = value_;
  }
  if (version !== '2' || !encoded || encoded.length > MAX_PAIRING_PAYLOAD_LENGTH) return null;
  const decoded = base64UrlDecode(encoded);
  if (!decoded || decoded.length > MAX_PAIRING_PAYLOAD_LENGTH) return null;
  try {
    return normalizePairingPayload(JSON.parse(decoded) as unknown);
  } catch {
    return null;
  }
};
