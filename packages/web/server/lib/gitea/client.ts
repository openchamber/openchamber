import { isPlainObject, isString } from '../shared/guards.js';
import type { JsonValue } from '../shared/json-values.js';

export interface GiteaFailure {
  kind?: unknown;
  code?: unknown;
  cause?: unknown;
  name?: unknown;
}

export type GiteaFetch = (input: string, init: Omit<RequestInit, 'body'> & { body?: string | undefined }) => Promise<Response>;
export type GiteaQuery = Record<string, JsonValue | undefined>;
export type GiteaBody = null | boolean | number | string | GiteaBody[] | { [key: string]: GiteaBody | undefined };

export interface GiteaClientOptions {
  origin: string;
  token?: string | null | undefined;
  fetch?: GiteaFetch | undefined;
  timeoutMs?: number | undefined;
  delay?: (ms: number) => Promise<void>;
  label?: string | undefined;
  namespace?: string | null;
}

interface SendOptions {
  query?: GiteaQuery | undefined;
  body?: GiteaBody | undefined;
  responseType?: 'json' | 'text' | 'bytes';
}

interface PageOptions {
  page?: number;
  limit?: number;
}

interface CollectionOptions {
  limit?: number;
  maxItems?: number;
  message?: string;
}

type GiteaHeaders = {
  accept: string;
  authorization?: string;
  'content-type'?: string;
};

const isGiteaFailure = (value: unknown): value is GiteaFailure => value !== null && value !== undefined;
const hasStringCode = (value: unknown): value is { code: string } => isGiteaFailure(value) && isString(value.code);

const RETRY_STATUSES = new Set([429, 502]);
const MAX_READ_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
const defaultDelay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export class GiteaRequestError extends Error {
  declare kind: string;
  declare status?: number;

  constructor(kind: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'GiteaRequestError';
    this.kind = kind;
    if (status !== null) this.status = status;
  }
}

const NETWORK_CODES = new Set(['ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

export function classifyGiteaFailure(error: GiteaFailure | null | undefined) {
  if (isString(error?.kind) && error instanceof GiteaRequestError) return error.kind;
  const code = isString(error?.code) ? error.code : hasStringCode(error?.cause) ? error.cause.code : '';
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || NETWORK_CODES.has(code) || code.startsWith('ERR_TLS')) {
    return 'unreachable';
  }
  return 'provider-error';
}

const kindOfStatus = (status: number) => {
  if (status === 401) return 'invalid-token';
  if (status === 429 || status >= 500) return 'temporarily-unavailable';
  return 'provider-error';
};

async function errorFromResponse(response: Response, label: string) {
  const text = await response.text().catch(() => '');
  let message = '';
  try {
    const payload: unknown = JSON.parse(text);
    if (isPlainObject(payload) && isString(payload.message)) message = payload.message;
  } catch {
    message = '';
  }
  return new GiteaRequestError(kindOfStatus(response.status), message || `${label} request failed with status ${response.status}`, response.status);
}

const hasNextLink = (link: string | null) => isString(link) && /<[^>]+>\s*;\s*rel="?next"?/i.test(link);

export function createGiteaClient({
  origin,
  token,
  fetch: fetchImpl = (input, init) => fetch(input, init),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delay = defaultDelay,
  label = 'Gitea',
  namespace = null,
}: GiteaClientOptions) {
  if (namespace !== null && !/^[a-z][a-z0-9-]*$/.test(namespace)) {
    throw new Error(`${label} client needs a plain API namespace`);
  }
  const base = new URL(origin);
  if (base.origin !== origin) throw new Error(`${label} client needs a normalized instance origin`);
  const apiPath = `/api/${namespace === null ? '' : `${namespace}/`}v1/`;
  const apiRoot = `${origin}${apiPath}`;

  const urlOf = (path: string, query?: GiteaQuery) => {
    const relative = String(path).replace(/^\/+/, '');
    const url = new URL(relative, apiRoot);
    if (url.origin !== base.origin || !url.pathname.startsWith(apiPath)) {
      throw new GiteaRequestError('provider-error', `${label} request path leaves the instance API`);
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  };

  type ResponseBody<T> = { status: number; headers: Headers; body: T | null };
  function send(method: string, path: string, options: SendOptions & { responseType: 'text' }): Promise<ResponseBody<string>>;
  function send(method: string, path: string, options: SendOptions & { responseType: 'bytes' }): Promise<ResponseBody<Buffer>>;
  function send(method: string, path: string, options: Omit<SendOptions, 'responseType'>): Promise<ResponseBody<JsonValue>>;
  async function send(method: string, path: string, { query, body, responseType = 'json' }: SendOptions): Promise<ResponseBody<JsonValue | Buffer>> {
    const url = urlOf(path, query);
    const headers: GiteaHeaders = { accept: responseType === 'json' ? 'application/json' : '*/*' };
    if (token) headers.authorization = `token ${token}`;
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const attempts = method === 'GET' ? MAX_READ_ATTEMPTS : 1;
    for (let attempt = 1; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      let response;
      try {
        response = await fetchImpl(url.toString(), { method, headers, body: payload, redirect: 'manual', signal: controller.signal });
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
          await response.body?.cancel().catch(() => {});
          throw new GiteaRequestError('provider-error', `${label} answered with a redirect; requests stay on the instance`, response.status || 502);
        }
        if (response.ok) {
          const result = { status: response.status, headers: response.headers };
          if (response.status === 204) return { ...result, body: null };
          if (responseType === 'text') return { ...result, body: await response.text() };
          if (responseType === 'bytes') return { ...result, body: Buffer.from(await response.arrayBuffer()) };
          const text = await response.text();
          const body: JsonValue = text ? JSON.parse(text) : null;
          return { ...result, body };
        }
        if (attempt >= attempts || !RETRY_STATUSES.has(response.status)) throw await errorFromResponse(response, label);
        await response.body?.cancel().catch(() => {});
      } catch (error) {
        if (error instanceof GiteaRequestError || error instanceof SyntaxError) throw error;
        if (attempt >= attempts) throw error;
      } finally {
        clearTimeout(timer);
      }
      await delay(2 ** attempt * 250);
    }
  }

  const page = async (path: string, query?: GiteaQuery, { page: number = 1, limit = 50 }: PageOptions = {}) => {
    const response = await send('GET', path, { query: { ...query, page: number, limit } });
    if (!Array.isArray(response.body)) throw new GiteaRequestError('provider-error', `${label} returned an invalid list`);
    const total = Number.parseInt(response.headers.get('x-total-count') ?? '', 10);
    const link = response.headers.get('link');
    const hasMore = link !== null
      ? hasNextLink(link)
      : Number.isInteger(total) ? number * limit < total : response.body.length >= limit;
    const items: JsonValue[] = response.body;
    return { items, hasMore, total: Number.isInteger(total) ? total : null };
  };

  return Object.freeze({
    get: async (path: string, query?: GiteaQuery) => (await send('GET', path, { query })).body,
    text: async (path: string, query?: GiteaQuery) => (await send('GET', path, { query, responseType: 'text' })).body,
    bytes: async (path: string, query?: GiteaQuery) => (await send('GET', path, { query, responseType: 'bytes' })).body,
    post: async (path: string, body?: GiteaBody) => (await send('POST', path, { body })).body,
    patch: async (path: string, body?: GiteaBody) => (await send('PATCH', path, { body })).body,
    put: async (path: string, body?: GiteaBody) => (await send('PUT', path, { body })).body,
    delete: async (path: string, body?: GiteaBody) => (await send('DELETE', path, { body })).body,
    page,
    collection: async (path: string, query?: GiteaQuery, { limit = 50, maxItems = 2000, message = `${label} list is longer than OpenChamber reads` }: CollectionOptions = {}) => {
      const items: JsonValue[] = [];
      for (let number = 1; ; number += 1) {
        const result = await page(path, query, { page: number, limit });
        items.push(...result.items);
        if (!result.hasMore || result.items.length === 0) return items;
        if (items.length >= maxItems) throw new GiteaRequestError('provider-error', message);
      }
    },
  });
}
