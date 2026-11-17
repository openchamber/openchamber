
import { z } from 'zod';

import { isEnterpriseMode } from '../enterprise-mode.js';
import { normalizeRelayUrl, pinnedRelayUrl } from '../relay/service.js';
import {
  canonicalPublicJwkString,
  deriveServerId,
  getOrCreateRelaySigningKeypair,
  signRelayMessage,
} from '../relay/signing-key.js';

const MAX_STATE_BATCH = 50;

const shareStateSchema = z.object({
  id: z.string(),
  status: z.enum(['open', 'locked', 'answered', 'expired', 'cancelled', 'missing', 'unavailable']),
  opens: z.array(z.number()).optional(),
  answer: z.string().nullable().optional(),
  answeredAt: z.number().nullable().optional(),
  closed: z.boolean().optional(),
});
const statesResponseSchema = z.object({ states: z.array(z.unknown()) });
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

export const isSharingAvailable = () => !isEnterpriseMode() || pinnedRelayUrl() !== null;

export const resolveShareRelayBase = (settings) => relayHttpBase(pinnedRelayUrl() ?? normalizeRelayUrl(settings?.privateRelay?.relayUrl));

export const relayHttpBase = (relayUrl) => {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
  url.pathname = url.pathname.replace(/\/ws\/?$/, '').replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
};

export const isRelayBaseAllowed = (base) => {
  if (!isEnterpriseMode()) return true;
  const pinned = pinnedRelayUrl();
  return pinned !== null && relayHttpBase(pinned) === base;
};

export const createRelayShareSigner = ({ crypto, relayKeyStore }) => {
  let cached = null;
  let cachedGeneration = -1;
  return async () => {
    const generation = relayKeyStore.generation();
    if (cached && cachedGeneration === generation) return cached;
    const signing = await getOrCreateRelaySigningKeypair({ crypto, relayKeyStore });
    const serverId = deriveServerId({ crypto }, signing.publicJwk);
    const pk = Buffer.from(canonicalPublicJwkString(signing.publicJwk), 'utf8').toString('base64url');
    cached = {
      serverId,
      pk,
      bodyHash: (body) => crypto.createHash('sha256').update(body).digest('base64url'),
      sign: (message) => signRelayMessage({ crypto }, signing.privateKey, message),
    };
    cachedGeneration = generation;
    return cached;
  };
};

class ShareRelayError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ShareRelayError';
    this.status = status;
  }
}

export const createShareRelayClient = ({ getSigner, fetchImpl = (...args) => fetch(...args), now = Date.now }) => {
  const call = async (base, path, body, { meta = '', timeoutMs = REQUEST_TIMEOUT_MS } = {}) => {
    const signer = await getSigner();
    const url = new URL(`${base}${path}`);
    const ts = now();
    const signature = signer.sign(`${ts}.share.${signer.serverId}.POST.${url.pathname}.${signer.bodyHash(body)}.${meta}`);
    const headers = {
      'content-type': meta ? 'application/octet-stream' : 'application/json',
      'x-openchamber-ts': String(ts),
      'x-openchamber-sig': signature,
      'x-openchamber-pk': signer.pk,
    };
    if (meta) headers['x-openchamber-share'] = meta;
    const response = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new ShareRelayError(`The relay answered ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
    }
    return response.json();
  };

  const json = (value) => Buffer.from(JSON.stringify(value));

  const create = (base, blob, { kind, wantsAnswer, expiresAt, authHash }) => {
    const meta = Buffer.from(JSON.stringify({ kind, wantsAnswer, expiresAt, authHash })).toString('base64url');
    return call(base, '/p', Buffer.from(blob), { meta, timeoutMs: UPLOAD_TIMEOUT_MS });
  };

  const states = async (base, ids) => {
    const result = [];
    for (let index = 0; index < ids.length; index += MAX_STATE_BATCH) {
      const batch = ids.slice(index, index + MAX_STATE_BATCH);
      const answer = statesResponseSchema.safeParse(await call(base, '/p/states', json({ ids: batch })));
      if (!answer.success) continue;
      for (const entry of answer.data.states) {
        const state = shareStateSchema.safeParse(entry);
        if (state.success) result.push(state.data);
      }
    }
    return result;
  };

  const close = async (base, id) => {
    const state = shareStateSchema.safeParse(await call(base, `/p/${encodeURIComponent(id)}/close`, json({})));
    return state.success ? state.data : null;
  };

  return { create, states, close };
};

const publicStateSchema = z.object({
  status: z.enum(['open', 'locked', 'answered', 'expired', 'cancelled', 'missing']),
  kind: z.string().optional(),
  wantsAnswer: z.boolean().optional(),
  expiresAt: z.number().optional(),
  answeredAt: z.number().nullable().optional(),
  attemptsLeft: z.number().optional(),
  error: z.string().optional(),
});

const STATE_STATUSES = {
  status: [200, 404],
  open: [403, 404, 409, 410, 423],
  answer: [200, 403, 404, 409, 410, 423],
};

export const createShareViewerClient = ({ fetchImpl = (...args) => fetch(...args) } = {}) => {
  const sharePath = (base, id, suffix) => `${base}/p/${encodeURIComponent(id)}${suffix}`;
  const request = (url, init = {}) => fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const post = (url, body) => request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const readState = async (response, route) => {
    if (!STATE_STATUSES[route].includes(response.status)) throw new ShareRelayError(`The relay answered ${response.status}`, response.status);
    const state = publicStateSchema.safeParse(await response.json().catch(() => null));
    if (!state.success) throw new ShareRelayError(`The relay answered ${response.status} without a share state`, response.status);
    return { ok: response.ok, httpStatus: response.status, state: state.data };
  };

  const status = async (base, id) => readState(await request(sharePath(base, id, '/status')), 'status');

  const open = async (base, id, auth) => {
    const response = await post(sharePath(base, id, '/open'), { auth });
    if (response.status !== 200) return readState(response, 'open');
    return { ok: true, httpStatus: 200, state: null, blob: new Uint8Array(await response.arrayBuffer()) };
  };

  const answer = async (base, id, auth, sealed) => readState(await post(sharePath(base, id, '/answer'), { auth, answer: sealed }), 'answer');

  return { status, open, answer };
};
