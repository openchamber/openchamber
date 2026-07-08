// Relay pairing offer URL codec (spec §Pairing payload).
// The offer JSON travels ONLY in the URL fragment so secrets (token) never
// reach servers, logs, or referrer headers via the query string.
// Shared by: settings UI (build), mobile scan (parse), desktop host import
// (parse), CLI (build).

import { base64UrlToBytes, bytesToBase64Url } from './crypto';
import type { RelayOfferV1 } from './protocol';

const OFFER_SCHEME = 'openchamber:';
const OFFER_HOST = 'connect';
const OFFER_FRAGMENT_KEY = 'offer=';

const REDACTED = '[redacted]';

export const buildRelayOfferUrl = (offer: RelayOfferV1): string => {
  const json = JSON.stringify(offer);
  const encoded = bytesToBase64Url(new TextEncoder().encode(json));
  return `openchamber://connect?v=1&mode=relay#${OFFER_FRAGMENT_KEY}${encoded}`;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isValidHttpOrWsUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'wss:' || parsed.protocol === 'ws:' || parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

const parsePublicKeyJwk = (value: unknown): JsonWebKey | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const jwk = value as Record<string, unknown>;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
  if (!isNonEmptyString(jwk.x) || !isNonEmptyString(jwk.y)) return null;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
};

// Strict parse: every required field is validated; any malformed or missing
// field rejects the whole offer (returns null, never a partial object).
export const parseRelayOfferUrl = (url: string): RelayOfferV1 | null => {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== OFFER_SCHEME) return null;
  // Custom-scheme URLs may surface the authority as hostname or pathname
  // depending on the runtime's parser.
  const authority = parsed.hostname || parsed.pathname.replace(/^\/*/, '').split(/[/?#]/)[0];
  if (authority !== OFFER_HOST) return null;
  if (parsed.searchParams.get('v') !== '1') return null;
  if (parsed.searchParams.get('mode') !== 'relay') return null;

  const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  if (!fragment.startsWith(OFFER_FRAGMENT_KEY)) return null;
  const encoded = fragment.slice(OFFER_FRAGMENT_KEY.length);
  if (!encoded) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;

  if (candidate.v !== 1) return null;
  if (candidate.mode !== 'relay') return null;
  if (!isNonEmptyString(candidate.relayUrl) || !isValidHttpOrWsUrl(candidate.relayUrl)) return null;
  if (!isNonEmptyString(candidate.serverId)) return null;
  const hostEncPubJwk = parsePublicKeyJwk(candidate.hostEncPubJwk);
  if (!hostEncPubJwk) return null;
  if (candidate.label !== undefined && !isNonEmptyString(candidate.label)) return null;
  if (candidate.token !== undefined && !isNonEmptyString(candidate.token)) return null;
  if (candidate.grant !== undefined && !isNonEmptyString(candidate.grant)) return null;

  return {
    v: 1,
    mode: 'relay',
    relayUrl: candidate.relayUrl,
    serverId: candidate.serverId,
    hostEncPubJwk,
    ...(candidate.label !== undefined ? { label: candidate.label } : {}),
    ...(candidate.token !== undefined ? { token: candidate.token } : {}),
    ...(candidate.grant !== undefined ? { grant: candidate.grant } : {}),
  };
};

// Safe-for-logging copy: masks the access token and the host public key
// coordinates. Never log a raw offer.
export const redactOffer = (offer: RelayOfferV1): RelayOfferV1 => ({
  ...offer,
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: REDACTED, y: REDACTED },
  ...(offer.token !== undefined ? { token: REDACTED } : {}),
  ...(offer.grant !== undefined ? { grant: REDACTED } : {}),
});
