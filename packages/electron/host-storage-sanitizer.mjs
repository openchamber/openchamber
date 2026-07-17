export const sanitizeHostRelayForStorage = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const relayUrl = typeof value.relayUrl === 'string' ? value.relayUrl.trim() : '';
  const serverId = typeof value.serverId === 'string' ? value.serverId.trim() : '';
  const jwk = value.hostEncPubJwk;
  if (!relayUrl || !serverId || !jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return null;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || !jwk.x || typeof jwk.y !== 'string' || !jwk.y) return null;
  try {
    const parsed = new URL(relayUrl);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
  } catch {
    return null;
  }
  return { relayUrl, serverId, hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
};

export const sanitizeHostDirectE2eeForStorage = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const wssUrl = typeof value.wssUrl === 'string' ? value.wssUrl.trim() : '';
  const jwk = value.hostEncPubJwk;
  if (!wssUrl || !jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return null;
  try {
    const url = new URL(wssUrl);
    if (url.protocol !== 'wss:' || url.pathname !== '/api/openchamber/direct-e2ee/ws' || url.search || url.hash || url.username || url.password) return null;
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || !jwk.x || typeof jwk.y !== 'string' || !jwk.y) return null;
    return { wssUrl: url.toString(), hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
  } catch {
    return null;
  }
};

const directHostFallbackLabel = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
};

export const buildStoredHostEntry = (entry, dependencies) => {
  const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
  if (!id || id === dependencies.localHostId) return null;
  const clientToken = dependencies.sanitizeClientToken(entry?.clientToken);
  const requestHeaders = dependencies.sanitizeRequestHeaders(entry?.requestHeaders);
  const headerFields = Object.keys(requestHeaders).length > 0 ? { requestHeaders } : {};
  const tokenField = clientToken ? { clientToken } : {};
  const labelRaw = typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : '';
  const relay = sanitizeHostRelayForStorage(entry?.relay);
  const directUrl = dependencies.sanitizeHostUrl(entry?.url);
  const apiUrl = dependencies.sanitizeHostUrl(entry?.apiUrl) || directUrl;
  const directE2ee = sanitizeHostDirectE2eeForStorage(entry?.directE2ee);
  const displayUrl = directUrl
    || (directE2ee ? `direct-e2ee://${new URL(directE2ee.wssUrl).hostname}` : null)
    || (relay ? `relay://${relay.serverId}` : null);
  if (!displayUrl) return null;
  const fallbackLabel = directUrl ? directHostFallbackLabel(directUrl) : displayUrl;
  return {
    id,
    label: labelRaw || fallbackLabel || displayUrl,
    url: displayUrl,
    ...(apiUrl ? { apiUrl } : {}),
    ...tokenField,
    ...headerFields,
    ...(directE2ee ? { directE2ee } : {}),
    ...(relay ? { relay } : {}),
  };
};
