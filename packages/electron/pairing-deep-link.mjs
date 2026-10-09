// Reads an `openchamber://connect?v=2&p=…` pairing link for the confirmation
// prompt. It only validates the link and names what it connects to: after the
// user confirms, the renderer redeems it with the same code as
// Settings > Remote Instances > Import Link, which knows both direct and relay
// transports and stores every leg on the host entry.

const decodePayload = (value) => {
  if (!value) return null;
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
};

const readText = (value) => (typeof value === 'string' ? value.trim() : '');

const directCandidateUrl = (candidate) => {
  try {
    const url = new URL(readText(candidate.url));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString().replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
};

// Same shape the host's buildRelayPairingCandidate emits and the renderer's
// connectionPayload accepts: a ws(s) relay URL, a server id, an EC public key.
const relayCandidateServerId = (candidate) => {
  const serverId = readText(candidate.serverId);
  const jwk = candidate.hostEncPubJwk;
  if (!serverId || !jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return null;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
  try {
    const url = new URL(readText(candidate.relayUrl));
    return url.protocol === 'ws:' || url.protocol === 'wss:' ? serverId : null;
  } catch {
    return null;
  }
};

const candidatePreview = (candidate) => {
  if (!candidate || typeof candidate !== 'object') return null;
  const priority = Number.isFinite(candidate.priority) ? candidate.priority : 100;
  if (candidate.type === 'lan' || candidate.type === 'tunnel') {
    const url = directCandidateUrl(candidate);
    return url ? { direct: true, target: url, priority } : null;
  }
  if (candidate.type === 'relay') {
    const serverId = relayCandidateServerId(candidate);
    return serverId ? { direct: false, target: `relay://${serverId}`, priority } : null;
  }
  return null;
};

/**
 * @returns {{ label: string, fingerprint: string, target: string } | null}
 * `target` is the first direct address by priority, else the relay display
 * address (`relay://<serverId>`, the form stored for relay-only hosts).
 */
export const parsePairingDeepLink = (raw, { protocol = 'openchamber', now = Date.now() } = {}) => {
  let url;
  try {
    url = new URL(readText(raw));
  } catch {
    return null;
  }
  if (url.protocol !== `${protocol}:` || url.hostname !== 'connect' || url.searchParams.get('v') !== '2') return null;
  const payload = decodePayload(readText(url.searchParams.get('p')));
  if (!payload || payload.v !== 2) return null;
  if (!readText(payload.pairingId) || !readText(payload.secret)) return null;
  const expiresAt = readText(payload.expiresAt);
  if (expiresAt) {
    const expiresTime = Date.parse(expiresAt);
    if (!Number.isFinite(expiresTime) || expiresTime <= now) return null;
  }
  const candidates = (Array.isArray(payload.candidates) ? payload.candidates : [])
    .map(candidatePreview)
    .filter(Boolean)
    .sort((left, right) => left.priority - right.priority);
  if (candidates.length === 0) return null;
  const preferred = candidates.find((candidate) => candidate.direct) || candidates[0];
  return {
    label: readText(payload.label) || 'OpenChamber',
    fingerprint: readText(payload.fingerprint),
    target: preferred.target,
  };
};
