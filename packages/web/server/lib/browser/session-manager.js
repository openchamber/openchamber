import { connectCdp as defaultConnectCdp } from './cdp.js';
import { createPolicyProxy as defaultCreatePolicyProxy } from './policy-proxy.js';

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_IDLE_TTL_MS = 5 * 60_000;
const IDLE_SWEEP_INTERVAL_MS = 60_000;
const USER_KEY = 'user';

const keyOf = ({ directory, openCodeSessionId }) => `${directory}\0${openCodeSessionId ?? USER_KEY}`;
const locatorOf = (value) => typeof value === 'string' ? value : keyOf(value);
const targetName = (targetId) => targetId || 'browser session';
const scopedError = (targetId, reason) => new Error(`Browser target ${targetName(targetId)}: ${reason}`);

/**
 * Owns directory/session-scoped Chrome contexts, policy proxies, and control leases.
 * Phase 4 chrome-devtools-mcp integration must acquire and respect this same lease.
 *
 * Agent mutation requests name their `abortSignal` explicitly; aborting invalidates
 * their generation, drops queued work, releases the lease, and ends ephemeral state.
 */
export const createBrowserSessionManager = ({
  chromeProcessManager,
  connectCdp = defaultConnectCdp,
  createPolicyProxy = defaultCreatePolicyProxy,
  proxyPolicy = {},
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  idleTtlMs = DEFAULT_IDLE_TTL_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) => {
  if (!chromeProcessManager?.ensureProcess) throw new Error('Browser session manager requires a Chrome process manager');
  const sessions = new Map();
  const lifecycleListeners = new Set();
  const controlListeners = new Set();
  const contextAdmissions = new Set();
  let exclusiveBrowserContext = null;
  let idleSweepTimer = null;
  let idleSweepPromise = null;
  let closed = false;
  let cdp = null;
  let cdpGeneration = null;
  let processDeathCleanup = null;
  let connecting = null;

  const emitLifecycle = (event) => {
    for (const listener of lifecycleListeners) {
      try { listener(event); } catch {}
    }
  };

  const snapshot = (session) => session && ({
    id: session.id,
    directory: session.directory,
    openCodeSessionId: session.openCodeSessionId,
    persistence: session.persistence,
    browserContextId: session.contextId,
    proxyServer: session.proxy?.proxyServer ?? null,
    dead: session.dead,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
  });

  const leaseSnapshot = (session) => session?.lease ? { ...session.lease } : null;

  const controlSnapshot = (session) => ({ generation: session.generation, lease: leaseSnapshot(session) });

  const emitControlChange = (session) => {
    for (const listener of controlListeners) {
      try { listener({ sessionId: session.id, ...controlSnapshot(session) }); } catch {}
    }
  };

  const releaseExclusiveContext = (session) => {
    if (exclusiveBrowserContext?.session === session) exclusiveBrowserContext = null;
  };

  const rejectOperation = (entry, reason) => {
    if (entry.settled) return;
    entry.settled = true;
    const error = scopedError(entry.targetId, reason);
    entry.controller.abort(error);
    entry.interrupted.resolve(error);
    entry.reject(error);
  };

  const clearLease = (session, reason) => {
    if (!session) return;
    if (session.leaseTimer) clearTimer(session.leaseTimer);
    session.leaseTimer = null;
    session.generation += 1;
    const queued = session.queue.splice(0);
    for (const entry of queued) rejectOperation(entry, reason);
    if (session.inFlight) rejectOperation(session.inFlight, reason);
    session.lease = null;
    emitControlChange(session);
  };

  const armLeaseExpiry = (session) => {
    if (session.leaseTimer) clearTimer(session.leaseTimer);
    const delay = Math.max(0, session.lease.expiresAt - now());
    session.leaseTimer = setTimer(() => clearLease(session, 'control lease expired'), delay);
  };

  const finishEntry = (session, entry) => {
    if (session.inFlight === entry) session.inFlight = null;
    session.running = false;
    pump(session);
  };

  const pump = (session) => {
    if (session.running || session.dead || session.closed) return;
    const entry = session.queue.shift();
    if (!entry) return;
    session.running = true;
    session.inFlight = entry;
    entry.generationAtStart = session.lease?.generation;
    void (async () => {
      try {
        const result = await Promise.race([
          entry.operation({
            abortSignal: entry.abortSignal,
            cdp: entry.cdp,
            browserContextId: session.contextId,
          }),
          entry.interrupted.promise.then((error) => { throw error; }),
        ]);
        if (entry.settled) return;
        if (!session.lease || session.lease.actor !== 'agent'
          || session.lease.generation !== entry.generationAtStart
          || session.lease.expiresAt <= now()) {
          rejectOperation(entry, 'control lease was invalidated while the operation ran');
          return;
        }
        entry.settled = true;
        entry.resolve(result);
      } catch (error) {
        rejectOperation(entry, error instanceof Error ? error.message : String(error));
      } finally {
        finishEntry(session, entry);
      }
    })();
  };

  const handleProcessDeath = async (reason = 'Chrome process died') => {
    cdp?.close();
    cdp = null;
    cdpGeneration = null;
    connecting = null;
    contextAdmissions.clear();
    exclusiveBrowserContext = null;
    const closes = [];
    for (const session of sessions.values()) {
      if (session.closed || session.dead) continue;
      session.dead = true;
      session.contextId = null;
      clearLease(session, reason);
      if (session.proxy) closes.push(session.proxy.close());
      session.proxy = null;
      emitLifecycle({ type: 'ended', sessionId: session.id, reason });
    }
    await Promise.allSettled(closes);
  };

  const ensureCdp = async () => {
    const processInfo = await chromeProcessManager.ensureProcess();
    if (cdp?.isOpen && cdpGeneration === processInfo.generation) return cdp;
    if (connecting) return connecting;
    connecting = (async () => {
      if (cdp) cdp.close();
      let client;
      try {
        client = await connectCdp(processInfo.webSocketDebuggerUrl);
      } catch (error) {
        await chromeProcessManager.kill?.();
        throw error;
      }
      cdp = client;
      cdpGeneration = processInfo.generation;
      processDeathCleanup?.();
      const child = processInfo.process;
      const onExit = () => {
        if (cdp === client && cdpGeneration === processInfo.generation) void handleProcessDeath('Chrome process died');
      };
      child?.once?.('exit', onExit);
      processDeathCleanup = () => child?.off?.('exit', onExit);
      client.onRegistry?.((event) => {
        if (event.type === 'disconnect' && cdp === client) void handleProcessDeath('Chrome process died');
      });
      return client;
    })().finally(() => { connecting = null; });
    return connecting;
  };

  const ensureResources = async (session, targetId) => {
    if (session.closed) throw scopedError(targetId, 'session is closed');
    if (exclusiveBrowserContext && exclusiveBrowserContext.session !== session) {
      throw scopedError(targetId, 'browser-wide tracing is active for another session');
    }
    if (session.contextId && session.proxy && cdp?.isOpen) return cdp;
    if (session.resourcesPromise) return session.resourcesPromise;
    contextAdmissions.add(session);
    const requireAdmission = () => {
      if (session.closed) throw new Error('session is closed');
      if (!contextAdmissions.has(session)) throw new Error('Chrome process died');
    };
    session.resourcesPromise = (async () => {
      let client = null;
      let proxy = null;
      let contextId = null;
      try {
        client = await ensureCdp();
        requireAdmission();
        proxy = createPolicyProxy(proxyPolicy);
        const proxyServer = await proxy.listen();
        requireAdmission();
        const result = await client.send('Target.createBrowserContext', {
          proxyServer,
          proxyBypassList: '<-loopback>',
        });
        if (typeof result?.browserContextId !== 'string') throw new Error('Chrome returned no browser context id');
        contextId = result.browserContextId;
        requireAdmission();
        await client.manageContext(contextId);
        requireAdmission();
        session.proxy = proxy;
        session.contextId = contextId;
        session.dead = false;
        session.lastActivityAt = now();
        return client;
      } catch (error) {
        try {
          if (contextId && client?.isOpen) {
            await client.unmanageContext(contextId).catch(() => {});
            await client.send('Target.disposeBrowserContext', { browserContextId: contextId });
            contextId = null;
          }
          if (!contextId) contextAdmissions.delete(session);
        } finally {
          await proxy?.close();
        }
        throw scopedError(targetId, error instanceof Error ? error.message : String(error));
      }
    })().finally(() => { session.resourcesPromise = null; });
    return session.resourcesPromise;
  };

  const createSession = async ({ directory, openCodeSessionId = null }) => {
    if (typeof directory !== 'string' || !directory) throw new Error('Browser session directory is required');
    const id = keyOf({ directory, openCodeSessionId });
    const existing = sessions.get(id);
    if (existing && !existing.closed) return snapshot(existing);
    const timestamp = now();
    const session = {
      id, directory, openCodeSessionId, persistence: openCodeSessionId ? 'ephemeral' : 'project',
      contextId: null, proxy: null, resourcesPromise: null, dead: false, closed: false, generation: 0,
      lease: null, leaseTimer: null, queue: [], running: false, inFlight: null,
      activeOperations: 0, viewers: new Set(),
      createdAt: timestamp, lastActivityAt: timestamp,
    };
    sessions.set(id, session);
    return snapshot(session);
  };

  const requireSession = (locator, targetId) => {
    const session = sessions.get(locatorOf(locator));
    if (!session || session.closed) throw scopedError(targetId, 'session was not found');
    return session;
  };

  const requireOwnedTarget = (session, client, targetId) => {
    const target = client.getTargets().find((entry) => entry.targetId === targetId);
    if (!target || target.type !== 'page' || target.browserContextId !== session.contextId) {
      throw scopedError(targetId, 'target does not belong to this browser session');
    }
  };

  const getPageConnection = async (locator, targetId) => {
    const session = requireSession(locator, targetId);
    const client = await ensureResources(session, targetId);
    requireOwnedTarget(session, client, targetId);
    const webSocketDebuggerUrl = chromeProcessManager.webSocketDebuggerUrl;
    if (!webSocketDebuggerUrl?.trim()) throw scopedError(targetId, 'browser debugger endpoint is unavailable');
    return { browserContextId: session.contextId, targetId, webSocketDebuggerUrl };
  };

  const acquireExclusiveBrowserContext = (locator) => {
    const session = requireSession(locator, 'tracing');
    if (!session.contextId || session.dead || !cdp?.isOpen) {
      throw scopedError('tracing', 'session has no live browser context');
    }
    if (exclusiveBrowserContext) throw scopedError('tracing', 'browser-wide tracing is already active');
    if (contextAdmissions.size !== 1 || !contextAdmissions.has(session)) {
      throw scopedError('tracing', 'browser-wide tracing requires an exclusive browser context');
    }
    const admission = { session };
    exclusiveBrowserContext = admission;
    return () => {
      if (exclusiveBrowserContext === admission) exclusiveBrowserContext = null;
    };
  };

  const endSession = async (locator, reason = 'session closed') => {
    const session = sessions.get(locatorOf(locator));
    if (!session) return false;
    if (session.closed) return session.closePromise ?? false;
    session.closed = true;
    clearLease(session, reason);
    const contextId = session.contextId;
    const client = cdp;
    session.contextId = null;
    const proxy = session.proxy;
    session.proxy = null;
    emitLifecycle({ type: 'ended', sessionId: session.id, reason });
    session.closePromise = (async () => {
      try {
        await session.resourcesPromise?.catch(() => {});
        if (contextId && client?.isOpen) {
          await client.unmanageContext(contextId).catch(() => {});
          await client.send('Target.disposeBrowserContext', { browserContextId: contextId }).catch((error) => {
            if (!/context.*(?:not found|does not exist|disposed)|Could not find/i.test(error.message)) throw error;
          });
          contextAdmissions.delete(session);
        }
      } finally {
        try {
          await proxy?.close();
        } finally {
          releaseExclusiveContext(session);
          if (sessions.get(session.id) === session) sessions.delete(session.id);
        }
      }
      return true;
    })();
    return session.closePromise;
  };

  const withAbort = async (session, targetId, abortSignal, operation, mutating = false) => {
    if (abortSignal?.aborted) throw scopedError(targetId, 'operation aborted');
    session.activeOperations += 1;
    try {
      if (!abortSignal) return await operation();
      const aborted = Promise.withResolvers();
      const onAbort = () => {
        aborted.reject(scopedError(targetId, 'operation aborted'));
        if (sessions.get(session.id) !== session) return;
        if (session.lease?.actor === 'user') return;
        if (mutating) clearLease(session, 'operation aborted');
        if (session.persistence === 'ephemeral') {
          void endSession(session.id, 'operation aborted').catch(() => {});
        }
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await Promise.race([operation(), aborted.promise]);
        if (abortSignal.aborted) throw scopedError(targetId, 'operation aborted');
        return result;
      } finally {
        abortSignal.removeEventListener('abort', onAbort);
      }
    } finally {
      session.activeOperations -= 1;
      session.lastActivityAt = now();
    }
  };

  const createTab = async (locator) => {
    const session = requireSession(locator, 'new tab');
    session.activeOperations += 1;
    try {
      const client = await ensureResources(session, 'new tab');
      const result = await client.send('Target.createTarget', { url: 'about:blank', browserContextId: session.contextId });
      if (typeof result?.targetId !== 'string') throw scopedError('new tab', 'Chrome returned no target id');
      return { id: `sc:${result.targetId}`, targetId: result.targetId, url: 'about:blank', title: '' };
    } finally {
      session.activeOperations -= 1;
      session.lastActivityAt = now();
    }
  };

  const listTabs = async (locator, { abortSignal } = {}) => {
    const session = requireSession(locator, 'tab list');
    return withAbort(session, 'tab list', abortSignal, async () => {
      const client = await ensureResources(session, 'tab list');
      if (abortSignal?.aborted) throw scopedError('tab list', 'operation aborted');
      return client.getTabs(session.contextId).map((target) => ({
        id: `sc:${target.targetId}`,
        targetId: target.targetId,
        title: target.title ?? '',
        url: target.url ?? '',
      }));
    });
  };

  const runReadOnlyOperation = async (locator, { targetId, operation, abortSignal, requireTargetOwnership = false }) => {
    const session = requireSession(locator, targetId);
    return withAbort(session, targetId, abortSignal, async () => {
      const client = await ensureResources(session, targetId);
      if (abortSignal?.aborted) throw scopedError(targetId, 'operation aborted');
      if (requireTargetOwnership) requireOwnedTarget(session, client, targetId);
      session.lastActivityAt = now();
      try {
        return await operation({ abortSignal, cdp: client, browserContextId: session.contextId });
      } catch (error) {
        throw scopedError(targetId, error instanceof Error ? error.message : String(error));
      }
    });
  };

  const runMutatingOperation = async (locator, {
    targetId,
    openCodeSessionId,
    abortSignal,
    operation,
    requireTargetOwnership = false,
  }) => {
    const session = requireSession(locator, targetId);
    if (typeof openCodeSessionId !== 'string' || openCodeSessionId !== session.openCodeSessionId) {
      throw scopedError(targetId, 'mutating operation does not hold this session lease');
    }
    if (session.lease && (session.lease.actor !== 'agent' || session.lease.openCodeSessionId !== openCodeSessionId)) {
      throw scopedError(targetId, 'mutating operation does not hold this session lease');
    }
    return withAbort(session, targetId, abortSignal, async () => {
      const client = await ensureResources(session, targetId);
      if (abortSignal?.aborted) throw scopedError(targetId, 'operation aborted');
      if (requireTargetOwnership) requireOwnedTarget(session, client, targetId);
      if (session.lease && (session.lease.actor !== 'agent' || session.lease.openCodeSessionId !== openCodeSessionId)) {
        throw scopedError(targetId, 'mutating operation does not hold this session lease');
      }
      if (!session.lease) {
        const acquiredAt = now();
        session.generation += 1;
        session.lease = {
          actor: 'agent', openCodeSessionId, generation: session.generation,
          acquiredAt, expiresAt: acquiredAt + leaseTtlMs,
        };
        armLeaseExpiry(session);
        emitControlChange(session);
      }
      session.lastActivityAt = now();
      return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const entry = {
          targetId, operation, cdp: client, resolve, reject, settled: false,
          controller, interrupted: Promise.withResolvers(),
          abortSignal: abortSignal ? AbortSignal.any([abortSignal, controller.signal]) : controller.signal,
        };
        session.queue.push(entry);
        pump(session);
      });
    }, true);
  };

  const viewerTakeover = (locator, viewerId) => {
    const session = requireSession(locator, 'viewer');
    if (!viewerId) throw scopedError('viewer', 'viewer identity is required');
    if (session.lease?.actor !== 'user' || session.lease.viewerId !== viewerId) {
      clearLease(session, 'viewer took control');
      session.lease = {
        actor: 'user', viewerId, openCodeSessionId: null,
        generation: session.generation, acquiredAt: now(), expiresAt: null,
      };
      emitControlChange(session);
    }
    session.lastActivityAt = now();
    return leaseSnapshot(session);
  };

  const viewerConnect = (locator, viewerId) => {
    const session = requireSession(locator, 'viewer');
    if (!viewerId) throw scopedError('viewer', 'viewer identity is required');
    if (session.viewers.has(viewerId)) return false;
    session.viewers.add(viewerId);
    session.lastActivityAt = now();
    return true;
  };

  const viewerDisconnect = (locator, viewerId) => {
    const session = sessions.get(locatorOf(locator));
    if (!session) return false;
    if (session.viewers.delete(viewerId)) session.lastActivityAt = now();
    if (session.lease?.actor !== 'user' || session.lease.viewerId !== viewerId) return false;
    clearLease(session, 'viewer disconnected');
    return true;
  };

  const expireIdleSessions = async () => {
    const timestamp = now();
    const expirations = [];
    for (const session of [...sessions.values()]) {
      if (session.activeOperations > 0 || session.viewers.size > 0) continue;
      if (timestamp - session.lastActivityAt < idleTtlMs) continue;
      clearLease(session, 'session idle expiry');
      if (session.persistence === 'ephemeral') expirations.push(endSession(session.id, 'session idle expiry'));
    }
    await Promise.allSettled(expirations);
  };

  const scheduleIdleSweep = () => {
    if (closed) return;
    idleSweepTimer = setTimer(() => {
      idleSweepTimer = null;
      idleSweepPromise = expireIdleSessions().finally(() => {
        idleSweepPromise = null;
        scheduleIdleSweep();
      });
    }, IDLE_SWEEP_INTERVAL_MS);
    idleSweepTimer?.unref?.();
  };

  scheduleIdleSweep();

  return {
    createSession,
    listSessions() { return [...sessions.values()].filter((session) => !session.closed).map(snapshot); },
    getSession(locator) { return snapshot(sessions.get(locatorOf(locator))); },
    endSession,
    abortSession(locator) { return endSession(locator, 'agent session aborted'); },
    createTab,
    listTabs,
    runMutatingOperation,
    runReadOnlyOperation,
    getPageConnection,
    acquireExclusiveBrowserContext,
    viewerConnect,
    viewerTakeover,
    viewerDisconnect,
    getLease(locator) { return leaseSnapshot(sessions.get(locatorOf(locator))); },
    getControlState(locator) { return controlSnapshot(requireSession(locator, 'control')); },
    onControlChange(listener) {
      controlListeners.add(listener);
      return () => controlListeners.delete(listener);
    },
    onLifecycle(listener) {
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },
    expireIdleSessions,
    handleProcessDeath,
    async close() {
      closed = true;
      if (idleSweepTimer) clearTimer(idleSweepTimer);
      idleSweepTimer = null;
      await idleSweepPromise;
      await Promise.allSettled([...sessions.keys()].map((id) => endSession(id)));
      processDeathCleanup?.();
      cdp?.close();
      cdp = null;
      lifecycleListeners.clear();
      controlListeners.clear();
    },
  };
};
