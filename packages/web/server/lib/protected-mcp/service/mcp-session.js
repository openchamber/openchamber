import { isPlainObject, isString } from '../../shared/guards.js';
import { MAX_FRAME_BYTES } from './contract.js';

const FALLBACK_TOOL = 'authorization_required';
const DEFAULT_PROTOCOL = '2025-06-18';

const toolMatches = (patterns, name) => patterns.some((pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern));

/** Whether the administrator's policy lets the agent see and call a tool. */
function toolAllowed(policy, name) {
  if (!isString(name)) return false;
  if (policy.allowTools && !toolMatches(policy.allowTools, name)) return false;
  return !(policy.denyTools && toolMatches(policy.denyTools, name));
}

const isRequest = (message) => isPlainObject(message) && isString(message.method) && message.id !== undefined && message.id !== null;
const isResponse = (message) => isPlainObject(message) && message.method === undefined && message.id !== undefined;

/** What the agent reads when a connection cannot run: who has to do what, and where. */
export function unavailableMessage({ name, reason }) {
  switch (reason) {
    case 'missing':
      return `The protected MCP connection "${name}" has no stored credential. Ask the administrator to add it in OpenChamber: Settings → MCP → ${name}.`;
    case 'authorization_required':
      return `The protected MCP connection "${name}" needs authorization. Ask the administrator to sign in to it in OpenChamber: Settings → MCP → ${name}.`;
    case 'runtime_installing':
      return `The MCP server of the protected connection "${name}" is still being installed. Reconnect it in a minute.`;
    default:
      return `The MCP server of the protected connection "${name}" could not start (${reason}). Ask the administrator to check it in OpenChamber: Settings → MCP → ${name}.`;
  }
}

/**
 * The MCP server a session talks to when its connection cannot run: one tool
 * whose description and result say what to do. The engine sees a connected
 * server with guidance instead of a silent failure.
 */
export function createFallbackBackend({ message, version }) {
  let onMessage = () => {};
  let onClose = () => {};
  const reply = (id, result) => queueMicrotask(() => onMessage({ jsonrpc: '2.0', id, result }));
  return {
    send(message_) {
      if (!isRequest(message_)) return;
      switch (message_.method) {
        case 'initialize':
          return reply(message_.id, {
            protocolVersion: isString(message_.params?.protocolVersion) ? message_.params.protocolVersion : DEFAULT_PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'openchamber-protected-mcp', version },
            instructions: message,
          });
        case 'ping':
          return reply(message_.id, {});
        case 'tools/list':
          return reply(message_.id, {
            tools: [{ name: FALLBACK_TOOL, description: message, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
          });
        case 'tools/call':
          return reply(message_.id, { content: [{ type: 'text', text: message }], isError: true });
        default:
          return queueMicrotask(() => onMessage({ jsonrpc: '2.0', id: message_.id, error: { code: -32601, message: 'Method not found' } }));
      }
    },
    onMessage(callback) { onMessage = callback; },
    onClose(callback) { onClose = callback; },
    close() { onClose(); },
  };
}

/**
 * Splits a byte stream into newline-delimited JSON values. A line that is not
 * JSON, or one longer than the frame limit, calls `onInvalid` and is dropped.
 */
export function createLineReader({ onValue, onInvalid = () => {}, onOverflow = () => {} }) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    let index;
    while ((index = buffer.indexOf(0x0a)) !== -1) {
      const line = buffer.subarray(0, index).toString('utf8').trim();
      buffer = buffer.subarray(index + 1);
      if (!line) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        onInvalid();
        continue;
      }
      onValue(value);
    }
    if (buffer.length > MAX_FRAME_BYTES) {
      buffer = Buffer.alloc(0);
      onOverflow();
    }
  };
}

/**
 * MCP sessions between relays and connections. The policy is read live from
 * the store on every message, so a policy change applies without a restart;
 * changes to the destination, credentials or enabled state end the sessions.
 */
export function createSessionManager({ store, startBackend, version, log = () => {} }) {
  const sessions = new Map();

  const open = (definition, socket, { initial, subject }) => {
    const pending = new Map();
    const session = { id: definition.id, subject, closed: false, end: () => {} };
    const group = sessions.get(definition.id) ?? new Set();
    group.add(session);
    sessions.set(definition.id, group);
    let backend = null;
    const queued = [];

    const write = (message) => {
      if (session.closed) return;
      if (socket.writableLength > MAX_FRAME_BYTES * 2) {
        // A relay that stops reading must not grow the service's memory.
        session.end('client_not_reading');
        return;
      }
      socket.write(`${JSON.stringify(message)}\n`);
    };

    // Argument names each tool declares, learned from tools/list, for the policy's defaults.
    const declared = new Map();
    const fromBackend = (message) => {
      if (Array.isArray(message)) return message.forEach(fromBackend);
      if (isResponse(message)) {
        const method = pending.get(message.id);
        pending.delete(message.id);
        if (method === 'tools/list' && isPlainObject(message.result) && Array.isArray(message.result.tools)) {
          const policy = store.get(definition.id)?.policy ?? {};
          for (const tool of message.result.tools) {
            const properties = tool?.inputSchema?.properties;
            if (isString(tool?.name) && isPlainObject(properties)) declared.set(tool.name, new Set(Object.keys(properties)));
          }
          return write({ ...message, result: { ...message.result, tools: message.result.tools.filter((tool) => toolAllowed(policy, tool?.name)) } });
        }
      }
      return write(message);
    };

    /** Fills arguments the agent left out, only where the tool declares them; never overrides one it gave. */
    const withDefaults = (message, policy) => {
      const defaults = policy.defaultArguments;
      const names = declared.get(message.params?.name);
      if (!defaults || !names) return message;
      const given = isPlainObject(message.params.arguments) ? message.params.arguments : {};
      const filled = { ...given };
      for (const [name, value] of Object.entries(defaults)) {
        if (names.has(name) && !Object.hasOwn(given, name)) filled[name] = value;
      }
      return { ...message, params: { ...message.params, arguments: filled } };
    };

    const fromClient = (incoming) => {
      if (session.closed) return undefined;
      if (Array.isArray(incoming)) return incoming.forEach(fromClient);
      if (!isPlainObject(incoming)) return undefined;
      let message = incoming;
      if (isRequest(message)) {
        if (message.method === 'tools/call') {
          const policy = store.get(definition.id)?.policy ?? {};
          if (!toolAllowed(policy, message.params?.name)) {
            return write({
              jsonrpc: '2.0',
              id: message.id,
              result: { content: [{ type: 'text', text: 'The administrator does not allow this tool on this connection.' }], isError: true },
            });
          }
          message = withDefaults(message, policy);
        }
        pending.set(message.id, message.method);
      }
      if (!backend) {
        queued.push(message);
        return undefined;
      }
      return backend.send(message);
    };

    session.end = (reason) => {
      if (session.closed) return;
      if (reason === 'connection_changed') {
        write({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'warning', logger: 'openchamber-protected-mcp', data: 'The administrator changed this protected connection. Reconnect it to continue.' } });
      }
      session.closed = true;
      group.delete(session);
      backend?.close();
      socket.end();
      setTimeout(() => socket.destroy(), 2000).unref();
    };

    const read = createLineReader({
      onValue: fromClient,
      onInvalid: () => write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
      onOverflow: () => session.end('frame_too_large'),
    });
    socket.on('data', read);
    socket.on('end', () => session.end('client_closed'));
    socket.on('close', () => session.end('client_closed'));
    socket.on('error', () => session.end('client_error'));
    if (initial.length > 0) read(initial);

    Promise.resolve(startBackend(definition))
      .catch((error) => {
        log('backend_start_failed', { connection: definition.id, code: error?.code ?? 'unknown' });
        return createFallbackBackend({
          message: unavailableMessage({ name: definition.name, reason: error?.code ?? 'start_failed' }),
          version,
        });
      })
      .then((started) => {
        if (session.closed) {
          started.close();
          return;
        }
        backend = started;
        backend.onMessage(fromBackend);
        backend.onClose(() => session.end('backend_closed'));
        for (const message of queued.splice(0)) backend.send(message);
      });
  };

  return {
    open,
    /** Ends every session of a connection after the administrator changed it. */
    endConnection(id, reason = 'connection_changed') {
      for (const session of [...(sessions.get(id) ?? [])]) session.end(reason);
    },
    restrictSubject(subject, allowed) {
      for (const [id, group] of sessions) {
        if (allowed.includes(id)) continue;
        for (const session of [...group]) if (session.subject === subject) session.end('subject_changed');
      }
    },
    closeAll() {
      for (const group of sessions.values()) for (const session of [...group]) session.end('service_closing');
    },
    count: (id) => sessions.get(id)?.size ?? 0,
    countAll: () => [...sessions.values()].reduce((count, group) => count + group.size, 0),
  };
}
