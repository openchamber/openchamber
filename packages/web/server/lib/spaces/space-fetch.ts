import type { IncomingMessage } from 'node:http';
const SESSION_PATH = '/api/session';
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 3_000;

const isSessionPath = (pathname: string) => pathname === SESSION_PATH || pathname.startsWith(`${SESSION_PATH}/`);

const abortOf = (signal: AbortSignal) => {
  let settle = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    settle = () => signal.removeEventListener('abort', onAbort);
  });
  promise.catch(() => {});
  return { promise, settle };
};

const readBody = (response: IncomingMessage, cap: number) => new Promise<string>((resolve, reject) => {
  const chunks: Buffer[] = [];
  let size = 0;
  let ended = false;
  response.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > cap) { response.destroy(); reject(new Error(`the answer exceeds ${cap} bytes`)); return; }
    chunks.push(chunk);
  });
  response.on('end', () => { ended = true; resolve(Buffer.concat(chunks).toString('utf8')); });
  response.on('error', reject);
  response.on('close', () => { if (!ended) reject(new Error('the answer closed before its end')); });
});

export interface SpaceFetchOptions {
  requestInside: (spaceId: string, request: {
    path: string;
    headers: Record<string, string>;
    timeoutMs: number;
  }) => Promise<IncomingMessage>;
  maxBytes?: number;
  timeoutMs?: number;
}

export function createSpaceFetch({ requestInside, maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS }: SpaceFetchOptions) {
  return (spaceId: string) => async (url: string | URL, { method = 'GET', signal }: { method?: string; signal?: AbortSignal | null } = {}) => {
    const { pathname, search } = new URL(url);
    if (method !== 'GET' || !isSessionPath(pathname)) {
      throw new Error(`a space is asked only to read its sessions, not ${method} ${pathname}`);
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
    stop.throwIfAborted();
    const aborted = abortOf(stop);
    const request = requestInside(spaceId, { path: `${pathname}${search}`, headers: { accept: 'application/json' }, timeoutMs });
    request.then((late) => { if (stop.aborted) late.destroy(); }, () => {});
    try {
      const response = await Promise.race([request, aborted.promise]);
      stop.addEventListener('abort', () => response.destroy(), { once: true });
      if (response.statusCode !== 200) {
        response.resume();
        const status = response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode <= 599 ? response.statusCode : 502;
        return new Response(null, { status });
      }
      const body = await Promise.race([readBody(response, maxBytes), aborted.promise]);
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    } finally {
      aborted.settle();
    }
  };
}
