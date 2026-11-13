import { sanitizeRuntimeRequestHeaders } from './runtime-request-headers.mjs';

export const LOCAL_HOST_ID = 'local';

export const normalizeHostUrl = (raw) => {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
};

export const sanitizeClientTokenForStorage = (raw) => {
  const token = typeof raw === 'string' ? raw.trim() : '';
  return token.length > 0 ? token : null;
};

// The relay descriptor { relayUrl (ws/wss), serverId, hostEncPubJwk } reaches a
// host over the E2EE tunnel; it may sit alongside a learned direct apiUrl (the
// multi-transport model below). The relay grant is a one-time pairing artifact
// and is never persisted.
export const sanitizeHostRelayForStorage = (value) => {
  if (!value || typeof value !== 'object') return null;
  const relayUrl = typeof value.relayUrl === 'string' ? value.relayUrl.trim() : '';
  const serverId = typeof value.serverId === 'string' ? value.serverId.trim() : '';
  const jwk = value.hostEncPubJwk;
  if (!relayUrl || !serverId || !jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return null;
  // Minimal EC public JWK shape check so a malformed descriptor is rejected at
  // storage time instead of surfacing later as a tunnel handshake failure.
  if (typeof jwk.kty !== 'string' || typeof jwk.crv !== 'string' || typeof jwk.x !== 'string') return null;
  try {
    const parsed = new URL(relayUrl);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
  } catch {
    return null;
  }
  return { relayUrl, serverId, hostEncPubJwk: jwk };
};

// Shared storage shape for a persisted host. A host may carry a direct HTTP
// transport, a relay transport, or BOTH (a multi-transport device: direct on
// the home network, relay away — mirrors the mobile connection model). Returns
// null for entries that can't be stored (missing id, reserved 'local', or no
// usable transport at all).
export const buildStoredHostEntry = (entry) => {
  const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
  if (!id || id === LOCAL_HOST_ID) return null;
  const clientToken = sanitizeClientTokenForStorage(entry?.clientToken);
  const requestHeaders = sanitizeRuntimeRequestHeaders(entry?.requestHeaders);
  const headerFields = Object.keys(requestHeaders).length > 0 ? { requestHeaders } : {};
  const tokenField = clientToken ? { clientToken } : {};
  const labelRaw = typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : '';

  const relay = sanitizeHostRelayForStorage(entry?.relay);
  const relayField = relay ? { relay } : {};
  const directUrl = normalizeHostUrl(entry?.url);
  const learnedApiUrl = normalizeHostUrl(entry?.apiUrl);

  if (directUrl) {
    return { id, label: labelRaw || directUrl, url: directUrl, apiUrl: learnedApiUrl || directUrl, ...tokenField, ...headerFields, ...relayField };
  }
  if (relay) {
    const url = `relay://${relay.serverId}`;
    const stored = { id, label: labelRaw || url, url, ...tokenField, ...headerFields, relay };
    // A relay host that learned a direct address keeps it: the renderer probes
    // and may switch to this leg, and the trusted-origin list must contain the
    // endpoint the renderer selects.
    if (learnedApiUrl) stored.apiUrl = learnedApiUrl;
    return stored;
  }
  return null;
};
