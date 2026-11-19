
import { z } from 'zod';
import type { JsonValue, ShareRelaySettings } from './contracts.js';
import type { createRelayKeyStore } from '../relay/key-store.js';

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

export const resolveShareRelayBase = (settings: ShareRelaySettings | null | undefined) => relayHttpBase(pinnedRelayUrl() ?? normalizeRelayUrl(settings?.privateRelay?.relayUrl));

export const relayHttpBase = (relayUrl: string) => {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
  url.pathname = url.pathname.replace(/\/ws\/?$/, '').replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
};

export const isRelayBaseAllowed = (base: string) => {
  if (!isEnterpriseMode()) return true;
  const pinned = pinnedRelayUrl();
  return pinned !== null && relayHttpBase(pinned) === base;
};

export interface ShareSigner {
  serverId: string;
  pk: string;
  bodyHash: (body: Uint8Array) => string;
  sign: (message: string) => string;
}

interface SignerOptions {
  crypto: typeof import('node:crypto');
  relayKeyStore: ReturnType<typeof createRelayKeyStore>;
}

export const createRelayShareSigner = ({ crypto, relayKeyStore }: SignerOptions) => {
  let cached: ShareSigner | null = null;
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
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ShareRelayError';
    this.status = status;
  }
}

interface RelayClientOptions {
  getSigner: () => Promise<ShareSigner>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface ShareMetadata {
  kind: 'page' | 'questionnaire';
  wantsAnswer: boolean;
  expiresAt: number;
  authHash: string;
}

type ShareHeaders = {
  'content-type': string;
  'x-openchamber-ts': string;
  'x-openchamber-sig': string;
  'x-openchamber-pk': string;
  'x-openchamber-share'?: string;
};

export type ShareState = z.infer<typeof shareStateSchema>;

export const createShareRelayClient = ({ getSigner, fetchImpl = (...args) => fetch(...args), now = Date.now }: RelayClientOptions) => {
  const call = async (base: string, path: string, body: Buffer<ArrayBuffer>, { meta = '', timeoutMs = REQUEST_TIMEOUT_MS }: { meta?: string; timeoutMs?: number } = {}): Promise<JsonValue> => {
    const signer = await getSigner();
    const url = new URL(`${base}${path}`);
    const ts = now();
    const signature = signer.sign(`${ts}.share.${signer.serverId}.POST.${url.pathname}.${signer.bodyHash(body)}.${meta}`);
    const headers: ShareHeaders = {
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

  const json = (value: JsonValue) => Buffer.from(JSON.stringify(value));

  const create = (base: string, blob: Uint8Array, { kind, wantsAnswer, expiresAt, authHash }: ShareMetadata) => {
    const meta = Buffer.from(JSON.stringify({ kind, wantsAnswer, expiresAt, authHash })).toString('base64url');
    return call(base, '/p', Buffer.from(blob), { meta, timeoutMs: UPLOAD_TIMEOUT_MS });
  };

  const states = async (base: string, ids: string[]) => {
    const result: ShareState[] = [];
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

  const close = async (base: string, id: string) => {
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

export interface ViewerStateReply {
  ok: boolean;
  httpStatus: number;
  state: z.infer<typeof publicStateSchema>;
}

export type ViewerOpenReply = (ViewerStateReply & { ok: false }) | {
  ok: true;
  httpStatus: number;
  state: null;
  blob: Uint8Array<ArrayBuffer>;
};

export const createShareViewerClient = ({ fetchImpl = (...args) => fetch(...args) }: { fetchImpl?: typeof fetch } = {}) => {
  const sharePath = (base: string, id: string, suffix: string) => `${base}/p/${encodeURIComponent(id)}${suffix}`;
  const request = (url: string, init: RequestInit = {}) => fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const post = (url: string, body: JsonValue) => request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  function readState(response: Response, route: 'open'): Promise<ViewerStateReply & { ok: false }>;
  function readState(response: Response, route: 'status' | 'answer'): Promise<ViewerStateReply>;
  async function readState(response: Response, route: keyof typeof STATE_STATUSES): Promise<ViewerStateReply> {
    if (!STATE_STATUSES[route].includes(response.status)) throw new ShareRelayError(`The relay answered ${response.status}`, response.status);
    const state = publicStateSchema.safeParse(await response.json().catch(() => null));
    if (!state.success) throw new ShareRelayError(`The relay answered ${response.status} without a share state`, response.status);
    return { ok: response.ok, httpStatus: response.status, state: state.data };
  }

  const status = async (base: string, id: string) => readState(await request(sharePath(base, id, '/status')), 'status');

  const open = async (base: string, id: string, auth: string): Promise<ViewerOpenReply> => {
    const response = await post(sharePath(base, id, '/open'), { auth });
    if (response.status !== 200) return readState(response, 'open');
    return { ok: true, httpStatus: 200, state: null, blob: new Uint8Array(await response.arrayBuffer()) };
  };

  const answer = async (base: string, id: string, auth: string, sealed: string) => readState(await post(sharePath(base, id, '/answer'), { auth, answer: sealed }), 'answer');

  return { status, open, answer };
};
