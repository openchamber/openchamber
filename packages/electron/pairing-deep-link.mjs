const decodePayload = (value) => {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

const normalizeHttpCandidate = (candidate) => {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  if (candidate.type !== 'lan' && candidate.type !== 'tunnel') return null;
  try {
    const url = new URL(typeof candidate.url === 'string' ? candidate.url.trim() : '');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return { type: candidate.type, url: url.toString(), priority: Number.isFinite(candidate.priority) ? candidate.priority : 100 };
  } catch {
    return null;
  }
};

export const decidePairingV2DeepLink = (raw, now = Date.now()) => {
  try {
    const url = new URL(typeof raw === 'string' ? raw.trim() : '');
    if (url.protocol !== 'openchamber:' || url.hostname !== 'connect' || url.searchParams.get('v') !== '2') return { kind: 'reject', reason: 'invalid' };
    const payload = decodePayload(url.searchParams.get('p') || '');
    if (!payload || payload.v !== 2 || typeof payload !== 'object' || Array.isArray(payload)) return { kind: 'reject', reason: 'invalid' };
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    if (candidates.some((candidate) => candidate?.type === 'direct-e2ee' || candidate?.type === 'relay')) {
      return { kind: 'reject', reason: 'encrypted-candidate' };
    }
    const normalizedCandidates = candidates.map(normalizeHttpCandidate);
    if (normalizedCandidates.length === 0 || normalizedCandidates.some((candidate) => !candidate)) return { kind: 'reject', reason: 'invalid' };
    const pairingId = typeof payload.pairingId === 'string' ? payload.pairingId.trim() : '';
    const secret = typeof payload.secret === 'string' ? payload.secret.trim() : '';
    const expiresAt = typeof payload.expiresAt === 'string' ? payload.expiresAt.trim() : '';
    if (!pairingId || !secret || (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now))) return { kind: 'reject', reason: 'invalid' };
    return {
      kind: 'accept',
      payload: {
        pairingId,
        secret,
        label: typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : 'OpenChamber',
        fingerprint: typeof payload.fingerprint === 'string' ? payload.fingerprint.trim() : '',
        expiresAt: expiresAt || null,
        candidates: normalizedCandidates.sort((left, right) => left.priority - right.priority),
      },
    };
  } catch {
    return { kind: 'reject', reason: 'invalid' };
  }
};
