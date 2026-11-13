import { isPlainObject, isString } from '../../shared/guards.js';
import { MAX_FRAME_BYTES } from './contract.js';

const MAX_RESPONSE_BYTES = 4 * MAX_FRAME_BYTES;
const DELETE_TIMEOUT_MS = 2000;

const isRequest = (message) => isPlainObject(message) && isString(message.method) && message.id !== undefined && message.id !== null;

async function readText(body, limit) {
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Server-sent events from a response body; each event's data is one JSON-RPC message. */
async function readEvents(body, onValue) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  const dispatch = () => {
    if (data.length === 0) return;
    const text = data.join('\n');
    data = [];
    try {
      onValue(JSON.parse(text));
    } catch {
      // A malformed event carries nothing the client can use.
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.length > MAX_FRAME_BYTES) {
      await reader.cancel();
      throw new Error('event too large');
    }
    let index;
    while ((index = buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + (buffer.startsWith('\r\n', index) ? 2 : 1));
      if (line === '') dispatch();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  dispatch();
}

/**
 * An MCP client for a remote server over Streamable HTTP, run by the service.
 * The credential goes into request headers here and nowhere else; responses
 * reach the relay as MCP messages without upstream headers or error bodies.
 */
export function startHttpUpstream({ definition, credentials, oauth, fetchImpl = fetch, unavailable, log = () => {} }) {
  const { url } = definition.http;
  const controllers = new Set();
  let sessionId = null;
  let protocolVersion = null;
  let closed = false;
  let streamOpened = false;
  let onMessage = () => {};
  let onClose = () => {};
  const emit = (message) => {
    if (!closed) onMessage(message);
  };
  const fail = (message, code, text) => {
    if (isRequest(message)) emit({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
  };

  /** Request headers, and the OAuth grant whose access token they carry, if any. */
  const headersFor = async ({ refresh = false, accept = 'application/json, text/event-stream' } = {}) => {
    const headers = { accept };
    for (const [name, value] of Object.entries(definition.http.headers)) {
      headers[name] = isString(value) ? value : `${value.prefix ?? ''}${credentials.secrets[value.secret]}`;
    }
    let tokens = null;
    if (definition.http.oauth) {
      tokens = await oauth.tokensFor(definition, { refresh });
      headers.authorization = `Bearer ${tokens.accessToken}`;
    }
    if (sessionId) headers['mcp-session-id'] = sessionId;
    if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
    return { headers, tokens };
  };

  const request = async (init, { refresh = false, accept } = {}) => {
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const { headers, tokens } = await headersFor({ refresh, accept });
      if (init.body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetchImpl(url, { ...init, headers, redirect: 'manual', signal: controller.signal });
      return { response, tokens, release: () => controllers.delete(controller) };
    } catch (error) {
      controllers.delete(controller);
      throw error;
    }
  };

  const post = async (message, retried = false) => {
    let exchange;
    try {
      exchange = await request({ method: 'POST', body: JSON.stringify(message) }, { refresh: retried });
    } catch (error) {
      if (error?.code === 'authorization_required') return fail(message, -32001, unavailable('authorization_required'));
      if (!closed) fail(message, -32603, 'The protected MCP service could not reach the upstream server.');
      return undefined;
    }
    const { response, tokens, release } = exchange;
    try {
      if ((response.status === 401 || response.status === 403) && definition.http.oauth && !retried) {
        await response.body?.cancel();
        release();
        return post(message, true);
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        // Only the grant this request carried is forgotten, not one authorized meanwhile.
        if (definition.http.oauth) await oauth.markUnauthorized(definition, { tokens });
        return fail(message, -32001, unavailable('authorization_required'));
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        log('upstream_redirect_refused', { connection: definition.id });
        return fail(message, -32603, 'The upstream server answered with a redirect, which the protected MCP service does not follow.');
      }
      if (!response.ok) {
        await response.body?.cancel();
        return fail(message, -32603, `The upstream server answered HTTP ${response.status}.`);
      }
      if (message.method === 'initialize') sessionId = response.headers.get('mcp-session-id') ?? sessionId;
      const handle = (value) => {
        if (message.method === 'initialize' && value?.id === message.id && isString(value?.result?.protocolVersion)) protocolVersion = value.result.protocolVersion;
        if (Array.isArray(value)) value.forEach(emit);
        else emit(value);
      };
      const type = (response.headers.get('content-type') ?? '').toLowerCase();
      if (response.status === 202 || !response.body) return undefined;
      if (type.startsWith('text/event-stream')) await readEvents(response.body, handle);
      else if (type.includes('json')) handle(JSON.parse(await readText(response.body, MAX_RESPONSE_BYTES)));
      else await response.body.cancel();
      return undefined;
    } catch {
      if (!closed) fail(message, -32603, 'The upstream server sent an answer the protected MCP service could not read.');
      return undefined;
    } finally {
      release();
    }
  };

  /** The optional stream for messages the server starts; a 405 means it has none. */
  const openStream = async () => {
    if (streamOpened || closed) return;
    streamOpened = true;
    try {
      const { response, release } = await request({ method: 'GET' }, { accept: 'text/event-stream' });
      try {
        if (response.ok && (response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/event-stream') && response.body) {
          await readEvents(response.body, (value) => emit(value));
        } else await response.body?.cancel();
      } finally {
        release();
      }
    } catch {
      // The stream is optional; requests keep working without it.
    }
  };

  return {
    send(message) {
      if (closed) return;
      const sent = post(message);
      if (isPlainObject(message) && message.method === 'notifications/initialized') sent.then(openStream);
    },
    onMessage(callback) { onMessage = callback; },
    onClose(callback) { onClose = callback; },
    close() {
      if (closed) return;
      closed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      if (sessionId) {
        const signal = AbortSignal.timeout(DELETE_TIMEOUT_MS);
        headersFor().then(({ headers }) => fetchImpl(url, { method: 'DELETE', headers, redirect: 'manual', signal }))
          .then((response) => response.body?.cancel())
          .catch(() => {});
      }
      onClose();
    },
  };
}
