// Signed host calls to the relay's share routes (openchamber-website
// apps/relay/src/share/routes.ts). Every call carries the relay identity the
// private relay and the push relay use; the signature covers the method, the
// path, the body hash and the metadata header (`buildSharePayload` there).

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

// One entry of `POST /p/states` (hostView in the relay's share-do.ts), or
// `{ id, status: 'missing' | 'unavailable' }`.
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

/**
 * Sharing reaches a relay, so in enterprise mode it exists only on a relay
 * the policy pins (decision 0005). Outside enterprise mode it is always there.
 */
export const isSharingAvailable = () => !isEnterpriseMode() || pinnedRelayUrl() !== null;

/**
 * The relay a new share goes to: the pinned one (policy, else
 * OPENCHAMBER_RELAY_URL), else the private relay setting, else ours. The
 * relay's WebSocket address names the Worker; its HTTP origin serves /p.
 */
export const resolveShareRelayBase = (settings) => relayHttpBase(pinnedRelayUrl() ?? normalizeRelayUrl(settings?.privateRelay?.relayUrl));

/** `wss://relay.example/ws` -> `https://relay.example`; a path prefix before /ws stays. */
export const relayHttpBase = (relayUrl) => {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
  url.pathname = url.pathname.replace(/\/ws\/?$/, '').replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
};

/**
 * Whether this server may talk to `base` now. In enterprise mode only the
 * pinned relay counts: a share made before the mode came on, on another
 * relay, is left alone instead of reaching outside the boundary.
 */
export const isRelayBaseAllowed = (base) => {
  if (!isEnterpriseMode()) return true;
  const pinned = pinnedRelayUrl();
  return pinned !== null && relayHttpBase(pinned) === base;
};

/** Signs share calls with the relay identity, re-read when the identity is reset. */
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

/**
 * `getSigner` resolves to `{ serverId, pk, bodyHash(body), sign(message) }`.
 * Errors carry the relay's status; the message never holds a key or a PIN.
 */
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
    const response = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new ShareRelayError(`The relay answered ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
    }
    return response.json();
  };

  const json = (value) => Buffer.from(JSON.stringify(value));

  /** Uploads one encrypted document; resolves to `{ id, url, expiresAt }`. */
  const create = (base, blob, { kind, wantsAnswer, expiresAt, authHash }) => {
    const meta = Buffer.from(JSON.stringify({ kind, wantsAnswer, expiresAt, authHash })).toString('base64url');
    return call(base, '/p', Buffer.from(blob), { meta, timeoutMs: UPLOAD_TIMEOUT_MS });
  };

  /** The relay's view of each share, in batches the relay accepts; an entry it garbled is left out. */
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

  /**
   * Collects or withdraws a share: the relay drops the page and the answer.
   * Closed before an answer arrived it reads as cancelled, after one as
   * answered, with `answer` holding the ciphertext the close deleted (null
   * when none was left). Resolves to null when the reply has another shape.
   */
  const close = async (base, id) => {
    const state = shareStateSchema.safeParse(await call(base, `/p/${encodeURIComponent(id)}/close`, json({})));
    return state.success ? state.data : null;
  };

  return { create, states, close };
};
