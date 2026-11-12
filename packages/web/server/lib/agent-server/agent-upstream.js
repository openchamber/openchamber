import http from 'node:http';
import net from 'node:net';
import { Readable, Transform } from 'node:stream';
import { z } from 'zod';

import { readAgentServerMode } from './mode.js';

export class AgentUpstreamError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** Refuses an oversized line or event before an SSE reader can accumulate it. */
export function boundedEventStream(source, cap) {
  let eventBytes = 0;
  let lineBytes = 0;
  let previousCR = false;
  const bounded = new Transform({
    transform(chunk, _encoding, callback) {
      for (const byte of chunk) {
        if (previousCR && byte === 10) { previousCR = false; continue; }
        previousCR = byte === 13;
        if (byte === 10 || byte === 13) {
          if (lineBytes === 0) eventBytes = 0;
          lineBytes = 0;
        } else {
          lineBytes += 1;
        }
        eventBytes += 1;
        if (lineBytes > cap || eventBytes > cap) {
          callback(new AgentUpstreamError('agent_stream_too_large'));
          return;
        }
      }
      callback(null, chunk);
    },
  });
  source.once('error', (error) => bounded.destroy(error));
  bounded.once('close', () => source.destroy());
  source.pipe(bounded);
  return bounded;
}

export async function readBoundedBody(response, cap) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      size += chunk.length;
      if (size > cap) throw new AgentUpstreamError('agent_response_too_large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { if (!response.complete) response.destroy(); }
}

// A path on the agent server's own origin: never another host, a line break, a backslash or a fragment.
const requestPathSchema = z.string().refine((value) => value.startsWith('/') && !value.startsWith('//') && !/[\r\n\\#]/.test(value));

/** One in-memory login shared by HTTP, sockets and every server-owned reader. */
export function createAgentUpstream({ url, token, now = Date.now, maxBytes = 4 * 1024 * 1024, eventBytes = 1024 * 1024, timeoutMs = 30_000 }) {
  const config = readAgentServerMode({ OPENCHAMBER_AGENT_SERVER_URL: url, OPENCHAMBER_AGENT_SERVER_TOKEN: token }).upstream;
  const base = new URL(config.url);
  const hostname = base.hostname.replace(/^\[|\]$/g, '');
  const port = Number(base.port || 80);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 32, timeout: 4_000 });
  const requestOptions = { hostname, port, agent };
  const active = new Set();
  let session = null;
  let login = null;
  let closed = false;

  const requestPath = (value) => {
    if (!requestPathSchema.safeParse(value).success) throw new AgentUpstreamError('agent_invalid_path');
    return value;
  };
  const once = ({ method = 'GET', path, headers = {}, body = null, signal, timeoutMs: deadline = timeoutMs }) => new Promise((resolve, reject) => {
    if (closed) { reject(new AgentUpstreamError('agent_unreachable')); return; }
    const req = http.request({ ...requestOptions, method, path: requestPath(path), headers: { ...headers, host: base.host, 'accept-encoding': 'identity' }, signal });
    active.add(req);
    const timer = setTimeout(() => req.destroy(new AgentUpstreamError('agent_unreachable')), deadline > 0 ? deadline : timeoutMs);
    timer?.unref();
    req.setTimeout(0);
    req.once('close', () => { clearTimeout(timer); active.delete(req); });
    req.once('response', (response) => { if (deadline === 0) clearTimeout(timer); resolve(response); });
    req.once('error', (error) => reject(error instanceof AgentUpstreamError ? error : new AgentUpstreamError('agent_unreachable')));
    if (body instanceof Readable) {
      const failed = () => req.destroy(new AgentUpstreamError('agent_unreachable'));
      body.once('error', failed);
      req.once('close', () => { body.removeListener('error', failed); body.unpipe(req); body.destroy(); });
      body.pipe(req);
    }
    else req.end(body ?? undefined);
  });

  const renew = () => {
    if (login) return login;
    session = null;
    login = (async () => {
      const response = await once({ method: 'POST', path: '/auth/session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: token }) });
      const line = response.headers['set-cookie']?.find((entry) => /^oc_ui_session(?:_\d+)?=/.test(entry));
      await readBoundedBody(response, 64 * 1024);
      if (response.statusCode >= 300 && response.statusCode < 400) throw new AgentUpstreamError('agent_redirected');
      const match = line?.match(/^(oc_ui_session(?:_\d+)?=[^;\r\n]+);.*\bMax-Age=(\d+)(?:;|$)/i);
      const ttl = Number(match?.[2]);
      if (response.statusCode !== 200 || !match || !Number.isSafeInteger(ttl) || ttl <= 0) throw new AgentUpstreamError('agent_login_failed');
      session = { cookie: match[1], renewAt: now() + ttl * 900 };
      return session.cookie;
    })().finally(() => { login = null; });
    return login;
  };
  const cookieFor = () => session && now() < session.renewAt ? Promise.resolve(session.cookie) : renew();
  const request = async (options) => {
    const cookie = await cookieFor();
    const send = (value) => once({ ...options, headers: { ...options.headers, cookie: value } });
    const hasBody = options.body !== null && options.body !== undefined || options.headers?.['content-length'] !== undefined || options.headers?.['transfer-encoding'] !== undefined;
    let response;
    try { response = await send(cookie); }
    catch (error) {
      // A body might have reached the agent before the connection failed.
      if (hasBody || options.signal?.aborted || error?.code !== 'agent_unreachable') throw error;
      response = await send(cookie);
    }
    if (response.statusCode === 401) {
      response.destroy();
      const fresh = await renew();
      if (hasBody) throw new AgentUpstreamError('agent_session_expired');
      response = await send(fresh);
      if (response.statusCode === 401) { response.destroy(); throw new AgentUpstreamError('agent_login_failed'); }
    }
    if (response.statusCode >= 300 && response.statusCode < 400 && response.statusCode !== 304) {
      response.destroy();
      throw new AgentUpstreamError('agent_redirected');
    }
    return response;
  };
  const json = async (path, options = {}) => {
    const response = await request({ ...options, path });
    const body = await readBoundedBody(response, maxBytes);
    if (response.statusCode < 200 || response.statusCode >= 300) throw new AgentUpstreamError('agent_unreachable');
    try { return JSON.parse(body); } catch { throw new AgentUpstreamError('agent_invalid_response'); }
  };
  const fetchAdapter = async (input, options = {}) => {
    const incomingRequest = input instanceof Request ? input : null;
    const requested = new URL(incomingRequest?.url ?? input, base);
    if (requested.origin !== base.origin) throw new AgentUpstreamError('agent_invalid_path');
    const headersIn = new Headers(options.headers ?? incomingRequest?.headers);
    const body = options.body ?? incomingRequest?.body;
    const sse = /text\/event-stream/i.test(headersIn.get('accept') ?? '');
    const response = await request({
      ...options, method: options.method ?? incomingRequest?.method, signal: options.signal ?? incomingRequest?.signal,
      body: body instanceof ReadableStream ? Readable.fromWeb(body) : body,
      path: `${requested.pathname}${requested.search}`, headers: Object.fromEntries(headersIn), timeoutMs: sse ? 0 : timeoutMs,
    });
    const headers = new Headers();
    for (const key of ['content-type', 'x-next-cursor']) if (response.headers[key]) headers.set(key, String(response.headers[key]));
    const status = response.statusCode;
    if (status === 204 || status === 304) { response.destroy(); return new Response(null, { status, headers }); }
    const responseBody = sse && status === 200
      ? Readable.toWeb(boundedEventStream(response, eventBytes))
      : await readBoundedBody(response, maxBytes);
    return new Response(responseBody, { status, headers });
  };
  return {
    request, json, fetch: fetchAdapter, cookieFor, renew, requestOptions,
    host: base.host, origin: base.origin, buildUrl: (path) => `${base.origin}${requestPath(path)}`,
    connect: () => new Promise((resolve, reject) => { const socket = net.connect({ host: hostname, port }); socket.once('connect', () => resolve(socket)); socket.once('error', reject); }),
    close() { closed = true; for (const req of active) req.destroy(); agent.destroy(); session = null; },
  };
}
