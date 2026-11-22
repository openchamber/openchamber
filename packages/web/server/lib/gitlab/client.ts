import { Gitlab } from '@gitbeaker/rest';
import { readBoundedResponseBytes, readBoundedResponseText } from '../shared/response-body.js';
import { isPlainObject, isString } from './validation.js';
import type { SourceControlJson } from '@openchamber/sdk';
import type { JsonValue } from '../shared/json-values.js';

type RequestValue = JsonValue | Date | undefined | RequestValue[] | RequestFields;
interface RequestFields { [key: string]: RequestValue }

export interface GitLabClientOptions {
  origin: string;
  token: string | undefined;
  tokenType?: 'token' | 'oauth';
  fetch?: (request: Request) => Promise<Response>;
}

export interface GitLabRequesterService {
  headers: Record<string, string>;
  authHeaders?: Record<string, () => Promise<string>>;
  url: string;
}

export interface GitLabRequesterOptions {
  body?: FormData | RequestFields;
  searchParams?: RequestFields;
  sudo?: string | number;
  signal?: AbortSignal;
  asStream?: boolean;
}

export type GitLabRequester = ReturnType<ReturnType<typeof createRequesterFn>>;

interface RequestErrorBody {
  error?: SourceControlJson;
  message?: SourceControlJson;
}

const hasErrorFields = (value: unknown): value is RequestErrorBody => value != null;

const RETRY_STATUSES = new Set([429, 502]);
const MAX_READ_ATTEMPTS = 3;
// Every request carries this per-attempt deadline, combined with the signal
// the caller supplied (the downloader disconnect signal, or the one
// GitBeaker builds from its queryTimeout). A self-managed instance that
// accepts a connection and then stalls otherwise hangs a request for
// GitBeaker's five-minute default, and the downloader without any bound.
// The module's other fetches use the same 10s bound (network.js).
const GITLAB_REQUEST_TIMEOUT_MS = 10_000;
// The error surface only ever shows a short excerpt, so the error body
// read is capped well above the excerpt instead of buffering the whole
// answer from a user-configured, possibly self-managed instance.
const ERROR_DETAIL_MAX_BYTES = 1_024;
const ERROR_DETAIL_EXCERPT_CHARS = 200;
// Success answers are read whole and parsed, so that read is capped
// while it streams in instead of buffering an unbounded answer from a
// user-configured, possibly self-managed instance. The callers are
// paginated (perPage <= 100) list and detail answers plus
// RepositoryFiles.showRaw raw files, which fit comfortably under
// 16 MiB, and the cap matches the 16 MiB bound the models.dev and npm
// success reads set under #1006.
const SUCCESS_BODY_MAX_BYTES = 16 * 1024 * 1024;

const decamelize = (key: string) => key.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();

function decamelizeKeys(value: RequestFields): RequestFields;
function decamelizeKeys(value: RequestValue): RequestValue;
function decamelizeKeys(value: RequestValue): RequestValue {
  if (Array.isArray(value)) return value.map(decamelizeKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [decamelize(key), decamelizeKeys(item)]));
}

function appendQuery(params: string[], key: string, value: RequestValue) {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) appendQuery(params, `${key}[]`, item);
    return;
  }
  if (isPlainObject(value)) {
    for (const [child, item] of Object.entries(value)) appendQuery(params, `${key}[${child}]`, item);
    return;
  }
  params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value instanceof Date ? value.toISOString() : `${value ?? ''}`)}`);
}

function formatQuery(searchParams?: RequestFields) {
  const params: string[] = [];
  for (const [key, value] of Object.entries(decamelizeKeys(searchParams ?? {}))) appendQuery(params, key, value);
  return params.join('&');
}

const successBodyTooLarge = () => Object.assign(
  new Error(`GitLab response exceeded ${SUCCESS_BODY_MAX_BYTES} bytes`),
  { code: 'response_too_large' },
);

async function parseBody(response: Response, asStream: boolean): Promise<JsonValue | Blob | ReadableStream<Uint8Array> | null> {
  if (asStream) return response.body;
  if (response.status === 204) return null;
  const contentType = ((response.headers.get('content-type') || '').split(';')[0] ?? '').trim();
  if (contentType === 'application/json' || contentType.startsWith('text/')) {
    const read = await readBoundedResponseText(response, SUCCESS_BODY_MAX_BYTES);
    if (read.tooLarge) throw successBodyTooLarge();
    // Response.json()/text() strip a leading UTF-8 BOM; the bounded
    // reader does not, so strip it here to keep the values callers
    // see unchanged.
    const text = read.text.replace(/^\uFEFF/, '');
    if (contentType === 'application/json') {
      const payload: SourceControlJson = JSON.parse(text);
      return payload || {};
    }
    return text || '';
  }
  const read = await readBoundedResponseBytes(response, SUCCESS_BODY_MAX_BYTES);
  if (read.tooLarge) throw successBodyTooLarge();
  return new Blob([new Uint8Array(read.bytes)], { type: response.headers.get('content-type') || '' });
}

async function requestError(request: Request, response: Response) {
  const read = await readBoundedResponseText(response, ERROR_DETAIL_MAX_BYTES)
    .catch(() => ({ tooLarge: true } as const));
  const content = read.tooLarge ? '' : read.text;
  let description: string | undefined = content;
  if ((response.headers.get('content-type') || '').includes('application/json')) {
    try {
      const payload: SourceControlJson = JSON.parse(content);
      const detail = (hasErrorFields(payload) && (payload.error || payload.message)) || '';
      description = isString(detail) ? detail : JSON.stringify(detail);
    } catch {
      description = content;
    }
  }
  description = (description || '').slice(0, ERROR_DETAIL_EXCERPT_CHARS);
  return new Error(description || `GitLab request failed with status ${response.status}`, {
    cause: { description, request, response },
  });
}

const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

// The deadline aborts through its own controller, so a stall rejects with
// an AbortError, which classifyGitLabFailure (network.js) maps to
// unreachable. A caller abort arrives through the combined signal with
// timedOut() false, so the two stay distinguishable for the retry policy.
function deadlineSignal(callerSignal: AbortSignal | null | undefined) {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, GITLAB_REQUEST_TIMEOUT_MS);
  return {
    signal: callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal,
    timedOut: () => controller.signal.aborted,
    clear: () => { clearTimeout(timer); },
  };
}

// One fetch bounded by the deadline. The bound covers the call itself,
// which for the downloader means the wait for response headers: the body
// it returns streams to the route caller without the deadline running.
async function fetchOnceWithDeadline(fetchImpl: (request: Request) => Promise<Response>, url: string | URL, init: RequestInit, callerSignal: AbortSignal | null | undefined) {
  const deadline = deadlineSignal(callerSignal);
  try {
    return await fetchImpl(new Request(url, { ...init, signal: deadline.signal }));
  } finally {
    deadline.clear();
  }
}

function createRequesterFn(fetchImpl: NonNullable<GitLabClientOptions['fetch']>) {
  return (serviceOptions: GitLabRequesterService) => {
    const send = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', endpoint: string, { body, searchParams, sudo, signal, asStream = false }: GitLabRequesterOptions = {}) => {
      const headers = { ...serviceOptions.headers };
      if (sudo) headers.sudo = `${sudo}`;
      let payload;
      if (body instanceof FormData) payload = body;
      else if (body) {
        payload = JSON.stringify(decamelizeKeys(body));
        headers['content-type'] = 'application/json';
      }
      const [authHeader] = Object.entries(serviceOptions.authHeaders ?? {});
      if (authHeader) headers[authHeader[0]] = await authHeader[1]();
      const url = new URL(endpoint, serviceOptions.url.endsWith('/') ? serviceOptions.url : `${serviceOptions.url}/`);
      url.search = formatQuery(searchParams);
      const attempts = method === 'GET' ? MAX_READ_ATTEMPTS : 1;
      for (let attempt = 1; ; attempt += 1) {
        const deadline = deadlineSignal(signal);
        try {
          const request = new Request(url, { method, headers, body: payload ?? null, signal: deadline.signal, redirect: 'error' });
          const response = await fetchImpl(request);
          if (response.ok) {
            return { body: await parseBody(response, asStream), headers: Object.fromEntries(response.headers.entries()), status: response.status };
          }
          if (attempt >= attempts || !RETRY_STATUSES.has(response.status)) throw await requestError(request, response);
          await response.body?.cancel().catch(() => {});
        } catch (error) {
          // A deadline abort retries like a 429/502 for reads and surfaces
          // for mutations, which are sent once. A caller abort has
          // timedOut() false and surfaces at once for every method.
          if (!deadline.timedOut() || attempt >= attempts) throw error;
        } finally {
          deadline.clear();
        }
        await delay(2 ** attempt * 250);
      }
    };
    const requester = (method: Parameters<typeof send>[0]) => (endpoint: string, options?: GitLabRequesterOptions) => send(method, endpoint, options);
    return { get: requester('GET'), post: requester('POST'), put: requester('PUT'), patch: requester('PATCH'), delete: requester('DELETE') };
  };
}

export interface GitLabDownloadOptions {
  range?: string | undefined;
  signal?: AbortSignal | undefined;
}


export function createGitLabDownloader({ origin, token, tokenType = 'token', fetch: fetchImpl = (request) => fetch(request) }: GitLabClientOptions) {
  const credential: Record<string, string> = tokenType === 'oauth' ? { authorization: `Bearer ${token}` } : { 'private-token': token === undefined ? 'undefined' : token };
  return async (apiPath: string, { range, signal }: GitLabDownloadOptions = {}) => {
    const headers: Record<string, string> = range ? { range } : {};
    const url = new URL(`api/v4/${apiPath}`, `${origin}/`);
    const response = await fetchOnceWithDeadline(fetchImpl, url, { headers: { ...headers, ...credential }, redirect: 'manual', signal: signal ?? null }, signal);
    if (response.status < 300 || response.status >= 400) return response;
    await response.body?.cancel().catch(() => {});
    const location = response.headers.get('location');
    const next = location ? new URL(location, url) : null;
    if (!next || (next.protocol !== 'https:' && next.origin !== url.origin)) {
      throw new Error('GitLab redirected the file to an address it may not be read from');
    }
    return fetchOnceWithDeadline(fetchImpl, next, { headers, redirect: 'error' }, signal);
  };
}

export function createGitLabClient({ origin, token, tokenType = 'token', fetch: fetchImpl = (request) => fetch(request) }: GitLabClientOptions): Gitlab {
  const requesterFn = createRequesterFn(fetchImpl);
  return tokenType === 'oauth'
    ? new Gitlab({ host: origin, oauthToken: token, requesterFn })
    : new Gitlab({ host: origin, token, requesterFn });
}
