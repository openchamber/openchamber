import { WebSocket } from 'ws';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const PAGE_DOMAINS = new Set(['CSS', 'DOM', 'Emulation', 'Input', 'Network', 'Page', 'Runtime']);
const AUDIT_NETWORK_EVENTS = new Set([
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.loadingFailed',
]);
const AUTO_ATTACH_PARAMS = {
  autoAttach: true,
  flatten: true,
  waitForDebuggerOnStart: false,
  filter: [{ type: 'page' }],
};

const isTargetInfo = (value) => value
  && typeof value === 'object'
  && typeof value.targetId === 'string'
  && typeof value.type === 'string';

const urlOrigin = (value) => {
  if (typeof value !== 'string') return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

const networkAuditSummary = (method, params) => {
  if (!AUDIT_NETWORK_EVENTS.has(method) || !params || typeof params !== 'object') return null;

  const summary = { eventType: method };
  if (typeof params.requestId === 'string') summary.requestId = params.requestId;
  if (typeof params.request?.method === 'string') summary.method = params.request.method;
  const origin = urlOrigin(params.request?.url ?? params.response?.url);
  if (origin !== undefined) summary.origin = origin;
  if (typeof params.type === 'string') summary.resourceType = params.type;
  if (typeof params.response?.status === 'number') summary.statusCode = params.response.status;
  if (method === 'Network.loadingFailed') {
    summary.failureCategory = params.blockedReason
      ? 'blocked'
      : params.corsErrorStatus
        ? 'cors'
        : params.canceled
          ? 'canceled'
          : 'failed';
  }
  return summary;
};

/**
 * Connects to a browser-level DevTools WebSocket and returns one flat-session
 * CDP client. The resolved client owns target discovery, target/session maps,
 * managed-context page attachment, registry queries, and redacted network audit events.
 *
 * @param {string} webSocketDebuggerUrl
 * @param {{ commandTimeoutMs?: number, managedContextIds?: Iterable<string>, logger?: Pick<Console, 'info'|'warn'> }} [options]
 */
export const connectCdp = async (webSocketDebuggerUrl, {
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  managedContextIds = [],
  logger = console,
} = {}) => {
  if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) {
    throw new Error('CDP command timeout must be a positive number');
  }

  const socket = new WebSocket(webSocketDebuggerUrl, {
    maxPayload: 256 * 1024 * 1024,
    perMessageDeflate: false,
  });
  const pending = new Map();
  const eventListeners = new Set();
  const registryListeners = new Set();
  const auditListeners = new Set();
  const targets = new Map();
  const targetToSession = new Map();
  const sessionToTarget = new Map();
  const auditedSessions = new Set();
  const managedContexts = new Set(managedContextIds);
  let nextId = 1;
  let disconnected = false;

  const emit = (listeners, value) => {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {}
    }
  };

  const commandError = (method, reason) => new Error(`CDP command ${method} failed: ${reason}`);

  const rejectPending = (reason) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(commandError(entry.method, reason));
    }
    pending.clear();
  };

  const dropSession = (sessionId) => {
    if (typeof sessionId !== 'string') return;
    const targetId = sessionToTarget.get(sessionId);
    sessionToTarget.delete(sessionId);
    auditedSessions.delete(sessionId);
    if (targetId && targetToSession.get(targetId) === sessionId) targetToSession.delete(targetId);
  };

  const dropTarget = (targetId) => {
    if (typeof targetId !== 'string') return;
    targets.delete(targetId);
    const sessionId = targetToSession.get(targetId);
    targetToSession.delete(targetId);
    if (sessionId) {
      sessionToTarget.delete(sessionId);
      auditedSessions.delete(sessionId);
    }
  };

  const disconnect = (reason) => {
    if (disconnected) return;
    disconnected = true;
    rejectPending(reason);
    targets.clear();
    targetToSession.clear();
    sessionToTarget.clear();
    auditedSessions.clear();
    emit(registryListeners, { type: 'disconnect', reason });
  };

  const sendCommand = (method, params = {}, sessionId) => {
    if (disconnected || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(commandError(method, 'connection is closed'));
    }

    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(commandError(method, `timed out after ${commandTimeoutMs}ms`));
      }, commandTimeoutMs);
      pending.set(id, { method, sessionId, resolve, reject, timeout });

      try {
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(commandError(method, error instanceof Error ? error.message : String(error)));
      }
    });
  };

  const sendRoot = (method, params = {}) => {
    const domain = String(method).split('.', 1)[0];
    if (PAGE_DOMAINS.has(domain)) {
      return Promise.reject(commandError(method, 'page commands require a target session'));
    }
    return sendCommand(method, params);
  };

  const sendSession = (sessionId, method, params = {}) => {
    if (!sessionToTarget.has(sessionId)) {
      return Promise.reject(commandError(method, `unknown target session ${sessionId}`));
    }
    return sendCommand(method, params, sessionId);
  };

  const enableAudit = (sessionId) => {
    if (auditedSessions.has(sessionId)) return;
    auditedSessions.add(sessionId);
    sendSession(sessionId, 'Network.enable').catch((error) => {
      auditedSessions.delete(sessionId);
      logger.warn?.(`[browser-cdp] Network.enable failed: ${error.message}`);
    });
  };

  const mapOwnedPageSession = (targetInfo, sessionId) => {
    if (!isTargetInfo(targetInfo)
      || targetInfo.type !== 'page'
      || !managedContexts.has(targetInfo.browserContextId)
      || typeof sessionId !== 'string') return false;

    const previousSession = targetToSession.get(targetInfo.targetId);
    if (previousSession && previousSession !== sessionId) dropSession(previousSession);
    const previousTarget = sessionToTarget.get(sessionId);
    if (previousTarget && previousTarget !== targetInfo.targetId) dropTarget(previousTarget);
    targetToSession.set(targetInfo.targetId, sessionId);
    sessionToTarget.set(sessionId, targetInfo.targetId);
    enableAudit(sessionId);
    return true;
  };

  const attachPage = async (targetId) => {
    const targetInfo = targets.get(targetId);
    if (!targetInfo || targetInfo.type !== 'page' || !managedContexts.has(targetInfo.browserContextId)) {
      throw new Error(`CDP target ${targetId} is not an owned page`);
    }
    const existing = targetToSession.get(targetId);
    if (existing) return existing;
    const result = await sendRoot('Target.attachToTarget', { targetId, flatten: true });
    if (typeof result?.sessionId !== 'string') {
      throw new Error(`CDP target ${targetId} attach returned no session`);
    }
    mapOwnedPageSession(targetInfo, result.sessionId);
    return result.sessionId;
  };

  const detachPage = async (targetId) => {
    const sessionId = targetToSession.get(targetId);
    if (!sessionId) return false;
    dropSession(sessionId);
    await sendRoot('Target.detachFromTarget', { sessionId });
    return true;
  };

  const handleEvent = (message) => {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    switch (message.method) {
      case 'Target.targetCreated':
        if (isTargetInfo(params.targetInfo)) {
          targets.set(params.targetInfo.targetId, params.targetInfo);
          emit(registryListeners, { type: 'upsert', target: params.targetInfo });
        }
        break;
      case 'Target.targetInfoChanged':
        if (isTargetInfo(params.targetInfo) && targets.has(params.targetInfo.targetId)) {
          targets.set(params.targetInfo.targetId, params.targetInfo);
          emit(registryListeners, { type: 'upsert', target: params.targetInfo });
        }
        break;
      case 'Target.targetDestroyed':
        if (typeof params.targetId === 'string') {
          dropTarget(params.targetId);
          emit(registryListeners, { type: 'destroy', targetId: params.targetId });
        }
        break;
      case 'Target.attachedToTarget':
        if (isTargetInfo(params.targetInfo)) targets.set(params.targetInfo.targetId, params.targetInfo);
        if (!mapOwnedPageSession(params.targetInfo, params.sessionId) && typeof params.sessionId === 'string') {
          sendRoot('Target.detachFromTarget', { sessionId: params.sessionId }).catch(() => {});
        }
        break;
      case 'Target.detachedFromTarget':
        dropSession(params.sessionId);
        break;
      default:
        break;
    }

    if (typeof message.sessionId === 'string' && auditedSessions.has(message.sessionId)) {
      const summary = networkAuditSummary(message.method, params);
      if (summary) {
        logger.info?.('[browser-cdp:audit]', summary);
        emit(auditListeners, summary);
      }
    }
    emit(eventListeners, { method: message.method, params, sessionId: message.sessionId });
  };

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      logger.warn?.('[browser-cdp] ignored malformed protocol frame');
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (Number.isInteger(message.id)) {
      const entry = pending.get(message.id);
      if (!entry) return;
      if (entry.sessionId !== message.sessionId) return;
      pending.delete(message.id);
      clearTimeout(entry.timeout);
      if (message.error) {
        entry.reject(commandError(entry.method, message.error.message || 'protocol error'));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method === 'string') handleEvent(message);
  });
  socket.on('close', () => disconnect('connection closed'));
  socket.on('error', () => {});

  await new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onClose = () => {
      cleanup();
      reject(new Error('CDP connection closed before opening'));
    };
    const cleanup = () => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });

  try {
    await sendRoot('Target.setDiscoverTargets', { discover: true });
    await sendRoot('Target.setAutoAttach', AUTO_ATTACH_PARAMS);
    const snapshot = await sendRoot('Target.getTargets');
    targets.clear();
    for (const targetInfo of snapshot?.targetInfos ?? []) {
      if (isTargetInfo(targetInfo)) targets.set(targetInfo.targetId, targetInfo);
    }
  } catch (error) {
    disconnect('initialization failed');
    socket.close();
    throw error;
  }

  const client = {
    /** Sends a browser/root-session command. Page-domain commands are rejected. */
    send: sendRoot,
    /** Sends a command on an already attached target session. */
    sendSession,
    /** Sends a page command by target id, never on the root session. */
    sendTarget(targetId, method, params = {}) {
      const sessionId = targetToSession.get(targetId);
      if (!sessionId) return Promise.reject(commandError(method, `target ${targetId} is not attached`));
      return sendSession(sessionId, method, params);
    },
    attach: attachPage,
    detach: detachPage,
    async manageContext(browserContextId) {
      managedContexts.add(browserContextId);
      const pages = [...targets.values()].filter((target) => target.type === 'page'
        && target.browserContextId === browserContextId
        && !targetToSession.has(target.targetId));
      await Promise.all(pages.map((target) => attachPage(target.targetId)));
    },
    async unmanageContext(browserContextId) {
      managedContexts.delete(browserContextId);
      const pages = [...targets.values()].filter((target) => target.browserContextId === browserContextId);
      await Promise.all(pages.map((target) => detachPage(target.targetId)));
    },
    getTargets: () => [...targets.values()],
    getTabs: (browserContextId) => [...targets.values()].filter((target) => target.type === 'page'
      && (browserContextId === undefined || target.browserContextId === browserContextId)),
    getSessionId: (targetId) => targetToSession.get(targetId) ?? null,
    getTargetId: (sessionId) => sessionToTarget.get(sessionId) ?? null,
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onRegistry(listener) {
      registryListeners.add(listener);
      return () => registryListeners.delete(listener);
    },
    onAudit(listener) {
      auditListeners.add(listener);
      return () => auditListeners.delete(listener);
    },
    close() {
      disconnect('connection closed by client');
      try { socket.close(); } catch {}
    },
    get isOpen() {
      return !disconnected && socket.readyState === WebSocket.OPEN;
    },
  };

  for (const target of targets.values()) {
    if (target.type === 'page' && managedContexts.has(target.browserContextId)) await attachPage(target.targetId);
  }
  return client;
};
