// JSON payload guards and HTTP request normalization for the relay tunnel client.
// Spec: .opencode/plans/private-relay/01-protocol-spec.md (Layer 3).

import type {
  TunnelHttpResponsePayload,
  TunnelStreamAbortPayload,
  TunnelWsClosePayload,
} from './protocol';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');

export const isHttpResponsePayload = (value: unknown): value is TunnelHttpResponsePayload =>
  isRecord(value) && typeof value.status === 'number' && isStringRecord(value.headers);

export const isStreamAbortPayload = (value: unknown): value is TunnelStreamAbortPayload =>
  isRecord(value) && typeof value.reason === 'string';

export const isWsClosePayload = (value: unknown): value is TunnelWsClosePayload =>
  isRecord(value) && typeof value.code === 'number' && typeof value.reason === 'string';

const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;

// Placeholder base for parsing origin-relative request paths; never fetched.
// Throwaway base for parsing relative runtime paths — only pathname+search are
// ever read, the host is discarded. Shared so relay modules don't diverge on it.
export const TUNNEL_PARSE_BASE = 'http://tunnel.invalid';

/** Extracts `pathname?search` from an absolute or relative WS/HTTP URL. */
export const wsUrlToTunnelPath = (url: string): string => {
  try {
    const parsed = ABSOLUTE_URL_PATTERN.test(url) ? new URL(url) : new URL(url, TUNNEL_PARSE_BASE);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
};

export interface NormalizedTunnelRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array> | null;
  signal?: AbortSignal;
}

const singleChunk = (bytes: Uint8Array): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield bytes;
  },
});

const streamChunks = (stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  },
});

const copyBytes = (view: ArrayBufferView): Uint8Array => {
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy;
};

const resolveBody = async (
  body: BodyInit | ReadableStream<Uint8Array> | null,
): Promise<{ body: AsyncIterable<Uint8Array> | null; contentType?: string }> => {
  if (body === null || body === undefined) return { body: null };
  if (body instanceof ReadableStream) return { body: streamChunks(body) };
  if (typeof body === 'string') return { body: singleChunk(new TextEncoder().encode(body)) };
  if (body instanceof ArrayBuffer) return { body: singleChunk(new Uint8Array(body.slice(0))) };
  if (ArrayBuffer.isView(body)) return { body: singleChunk(copyBytes(body)) };
  // Blob / FormData / URLSearchParams: let Response serialize the body exactly
  // like a native fetch would, and surface the content-type it derives
  // (e.g. the multipart boundary for FormData).
  const probe = new Response(body);
  const contentType = probe.headers.get('content-type') ?? undefined;
  const bytes = new Uint8Array(await probe.arrayBuffer());
  return { body: singleChunk(bytes), contentType };
};

/**
 * Flattens a fetch-style (input, init) pair into the tunnel HttpRequest shape,
 * preserving method, headers, body bytes/stream, and abort signal.
 */
export const normalizeTunnelRequest = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<NormalizedTunnelRequest> => {
  let urlValue: string;
  const headers = new Headers();
  let method = 'GET';
  let bodySource: BodyInit | ReadableStream<Uint8Array> | null = null;
  let signal: AbortSignal | undefined;

  if (input instanceof Request) {
    urlValue = input.url;
    method = input.method;
    input.headers.forEach((value, key) => headers.set(key, value));
    signal = input.signal;
    bodySource = input.body;
  } else {
    urlValue = input.toString();
  }

  if (init) {
    if (init.method) method = init.method;
    if (init.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (init.body !== undefined) bodySource = init.body;
    if (init.signal) signal = init.signal;
  }

  const url = ABSOLUTE_URL_PATTERN.test(urlValue) ? new URL(urlValue) : new URL(urlValue, TUNNEL_PARSE_BASE);
  const { body, contentType } = await resolveBody(bodySource);
  if (contentType && !headers.has('content-type')) headers.set('content-type', contentType);

  const headerRecord: Record<string, string> = {};
  headers.forEach((value, key) => {
    headerRecord[key] = value;
  });

  return {
    method: method.toUpperCase(),
    path: url.pathname,
    query: url.search.startsWith('?') ? url.search.slice(1) : url.search,
    headers: headerRecord,
    body,
    signal,
  };
};
