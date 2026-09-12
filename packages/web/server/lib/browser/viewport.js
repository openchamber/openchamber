import {
  applyViewportMetrics,
  clearViewportMetrics,
  MAX_VIEWPORT_DIMENSION,
  MIN_VIEWPORT_DIMENSION,
  readViewportMetrics,
} from './viewport-metrics.js';

const managers = new WeakMap();
const RESIZE_TIMEOUT_MS = 5_000;

export class BrowserViewportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrowserViewportError';
    this.code = code;
  }
}

const failure = (code) => new BrowserViewportError(code, {
  INVALID_VIEWPORT: 'Invalid browser viewport',
  STALE_ATTACHMENT: 'Browser viewer attachment is no longer current',
  SUPERSEDED: 'Browser viewport request was superseded',
  RESIZE_TIMEOUT: 'Browser viewport request timed out',
  RESIZE_FAILED: 'Browser viewport could not be confirmed',
}[code]);

const validateViewport = (viewport) => {
  if (![viewport.width, viewport.height].every((value) => Number.isInteger(value)
    && value >= MIN_VIEWPORT_DIMENSION && value <= MAX_VIEWPORT_DIMENSION)
    || ![true, false].includes(viewport.mobile)) throw failure('INVALID_VIEWPORT');
};

const sameMetrics = (left, right) => left !== null && Object.keys(right).every((key) => left[key] === right[key]);
const sameConfig = (left, right) => left !== null && right !== null
  && Object.keys(right).every((key) => left[key] === right[key]);

const createViewportManager = (browserSessionManager) => {
  const sessions = new Map();
  const listeners = new Set();

  const getRecord = (sessionId, targetId, create = true) => {
    let targets = sessions.get(sessionId);
    if (!targets && create) sessions.set(sessionId, targets = new Map());
    let record = targets?.get(targetId);
    if (!record && create) {
      record = {
        sessionId, targetId, revision: 0, observed: null, config: null, owner: null,
        authority: 0, observationEpoch: 0, disposed: false, physicalUncertain: false,
        reservation: null, inFlight: null, pending: null, observation: null,
        devtools: new Map(),
      };
      targets.set(targetId, record);
    }
    return record;
  };

  const publish = (record) => {
    if (record.disposed) return;
    record.revision += 1;
    for (const listener of listeners) {
      try { listener({ sessionId: record.sessionId, targetId: record.targetId }); } catch {}
    }
  };

  const leaseAllowsViewer = (record, viewerId) => {
    const { lease } = browserSessionManager.getControlState(record.sessionId);
    return !lease || (lease.actor === 'user' && lease.viewerId === viewerId);
  };

  const autoAllowed = (record, viewerId) => {
    if (!viewerId || !leaseAllowsViewer(record, viewerId)) return false;
    const owner = reservedOwner(record) ?? record.owner;
    return owner === null || (owner.actor === 'viewer' && owner.viewerId === viewerId && owner.mode === 'auto');
  };

  const reservedOwner = (record) => {
    if (record.reservation) return record.reservation.owner;
    const current = record.inFlight;
    if (current && !current.settled && current.authority === record.authority
      && current.controlGeneration === browserSessionManager.getControlState(record.sessionId).generation) return current.owner;
    return null;
  };

  const snapshotOf = (record, viewerId) => {
    if (!record || record.disposed || !record.observed) return null;
    return {
      revision: record.revision,
      width: record.config?.width ?? record.observed.layoutWidth,
      height: record.config?.height ?? record.observed.layoutHeight,
      mode: record.config?.mode ?? 'external',
      source: record.config?.source ?? 'external',
      mobile: record.config?.mobile ?? null,
      deviceScaleFactor: record.config?.deviceScaleFactor ?? null,
      observed: { ...record.observed },
      autoAllowed: autoAllowed(record, viewerId),
    };
  };

  const settle = (record, job, error, result) => {
    if (job.settled) return;
    job.settled = true;
    job.error = error;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.onAbort);
    if (record.pending === job) record.pending = null;
    if (record.reservation === job) {
      record.reservation = null;
      if (error) publish(record);
    }
    if (error) job.response.reject(error);
    else job.response.resolve(result);
  };

  const requireActive = (record, job) => {
    if (job.settled) throw job.error ?? failure('SUPERSEDED');
    if (record.disposed || job.signal?.aborted || !job.isCurrent()) throw failure('STALE_ATTACHMENT');
    if (job.authority !== record.authority
      || job.controlGeneration !== browserSessionManager.getControlState(record.sessionId).generation) {
      throw failure('SUPERSEDED');
    }
  };

  const pump = (record) => {
    if (record.disposed || record.inFlight || !record.pending) return;
    const job = record.pending;
    record.pending = null;
    record.inFlight = job;
    void (async () => {
      try {
        requireActive(record, job);
        const perform = async (cdp, existingSessionId) => {
          requireActive(record, job);
          const cdpSessionId = existingSessionId ?? cdp.getSessionId(record.targetId) ?? await cdp.attach(record.targetId);
          requireActive(record, job);
          if (!record.physicalUncertain && sameConfig(record.config, job.config) && record.owner?.actor === job.owner.actor
            && record.owner?.viewerId === job.owner.viewerId) return 'unchanged';
          record.observationEpoch += 1;
          record.physicalUncertain = true;
          const guardedCdp = {
            sendSession(...args) {
              requireActive(record, job);
              return cdp.sendSession(...args);
            },
          };
          let observed;
          if (job.apply) {
            await job.apply();
            requireActive(record, job);
            observed = await readViewportMetrics(guardedCdp, cdpSessionId);
          } else {
            observed = job.config
              ? await applyViewportMetrics(guardedCdp, cdpSessionId, job.config)
              : await clearViewportMetrics(guardedCdp, cdpSessionId);
          }
          requireActive(record, job);
          record.observed = observed;
          record.config = job.config;
          record.owner = job.owner;
          record.physicalUncertain = false;
          record.observationEpoch += 1;
          publish(record);
          return 'applied';
        };
        const status = job.cdp
          ? await perform(job.cdp, job.cdpSessionId)
          : await browserSessionManager.runReadOnlyOperation(record.sessionId, {
            targetId: record.targetId,
            requireTargetOwnership: true,
            operation: ({ cdp }) => perform(cdp),
          });
        requireActive(record, job);
        const viewport = snapshotOf(record, job.owner.viewerId ?? null);
        settle(record, job, null, job.owner.actor === 'viewer' ? { status, viewport } : viewport);
      } catch {
        let error = failure('RESIZE_FAILED');
        try { requireActive(record, job); } catch (inactive) { error = inactive; }
        settle(record, job, error);
      } finally {
        // A response deadline never releases the physical CDP writer early.
        record.inFlight = null;
        job.finished.resolve();
        pump(record);
      }
    })();
  };

  const enqueue = (record, options) => {
    const job = {
      ...options,
      response: Promise.withResolvers(), finished: Promise.withResolvers(), settled: false,
      authority: record.authority,
      controlGeneration: browserSessionManager.getControlState(record.sessionId).generation,
    };
    job.onAbort = () => settle(record, job, failure('STALE_ATTACHMENT'));
    job.timer = setTimeout(() => settle(record, job, failure('RESIZE_TIMEOUT')), RESIZE_TIMEOUT_MS);
    job.signal?.addEventListener('abort', job.onAbort, { once: true });
    if (record.pending) settle(record, record.pending, failure('SUPERSEDED'));
    record.reservation = job;
    record.pending = job;
    publish(record);
    if (job.signal?.aborted) job.onAbort();
    pump(record);
    return job.response.promise;
  };

  const observeRecord = (record) => {
    if (record.observation) return record.observation;
    record.observation = (async () => {
      while (!record.disposed) {
        while (record.inFlight) await record.inFlight.finished.promise;
        if (record.disposed) throw failure('STALE_ATTACHMENT');
        const epoch = record.observationEpoch;
        let observed;
        try {
          observed = await browserSessionManager.runReadOnlyOperation(record.sessionId, {
            targetId: record.targetId,
            requireTargetOwnership: true,
            operation: async ({ cdp }) => {
              const cdpSessionId = cdp.getSessionId(record.targetId) ?? await cdp.attach(record.targetId);
              return readViewportMetrics(cdp, cdpSessionId);
            },
          });
        } catch { throw failure('RESIZE_FAILED'); }
        if (record.disposed) throw failure('STALE_ATTACHMENT');
        if (epoch !== record.observationEpoch || record.inFlight) continue;
        if (!sameMetrics(record.observed, observed)) {
          record.observed = observed;
          record.observationEpoch += 1;
          publish(record);
        }
        return snapshotOf(record, null);
      }
      throw failure('STALE_ATTACHMENT');
    })().finally(() => { record.observation = null; });
    return record.observation;
  };

  const read = async (sessionId, targetId, viewerId) => {
    const record = getRecord(sessionId, targetId);
    if (!record.observed) await observeRecord(record);
    return snapshotOf(record, viewerId);
  };

  const setViewer = async ({ sessionId, targetId, viewerId, width, height, mode, mobile, takeover = false, isCurrent = () => true, signal }) => {
    if (signal?.aborted || !isCurrent()) throw failure('STALE_ATTACHMENT');
    if (!viewerId || !['auto', 'fixed'].includes(mode)) throw failure('INVALID_VIEWPORT');
    validateViewport({ width, height, mobile });
    const record = getRecord(sessionId, targetId);
    if (takeover) {
      browserSessionManager.viewerTakeover(sessionId, viewerId);
      record.authority += 1;
    } else {
      const owner = reservedOwner(record) ?? record.owner;
      const ownsFixed = mode === 'fixed' && owner?.actor === 'viewer' && owner.viewerId === viewerId
        && leaseAllowsViewer(record, viewerId);
      if (!autoAllowed(record, viewerId) && !ownsFixed) {
        const viewport = await read(sessionId, targetId, viewerId);
        if (signal?.aborted || !isCurrent()) throw failure('STALE_ATTACHMENT');
        return { status: 'not-owner', viewport };
      }
    }
    return enqueue(record, {
      owner: { actor: 'viewer', viewerId, mode },
      config: { width, height, mode, mobile, source: 'viewer', deviceScaleFactor: 1 },
      isCurrent, signal,
    });
  };

  const applyAgent = ({ sessionId, targetId, cdp, cdpSessionId, viewport, signal }) => {
    if (signal?.aborted) return Promise.reject(failure('STALE_ATTACHMENT'));
    if (viewport !== null) validateViewport(viewport);
    const record = getRecord(sessionId, targetId);
    record.authority += 1;
    return enqueue(record, {
      owner: { actor: 'agent' },
      config: viewport === null ? null : { ...viewport, mode: 'fixed', source: 'agent', deviceScaleFactor: 1 },
      cdp, cdpSessionId, signal, isCurrent: () => true,
    });
  };

  const external = async ({ sessionId, targetId, viewerId, devtoolsId, type, apply }) => {
    const record = getRecord(sessionId, targetId, type === 'open');
    if (!record || !devtoolsId) return;
    if (type === 'open') {
      record.devtools.set(devtoolsId, viewerId);
      return;
    }
    if (!record.devtools.has(devtoolsId) || record.devtools.get(devtoolsId) !== viewerId) return;
    if (type === 'close') {
      record.devtools.delete(devtoolsId);
      return;
    }
    if (type !== 'changed') return;
    record.authority += 1;
    record.observationEpoch += 1;
    record.owner = { actor: 'external' };
    record.config = null;
    if (record.pending) settle(record, record.pending, failure('SUPERSEDED'));
    if (record.inFlight) settle(record, record.inFlight, failure('SUPERSEDED'));
    publish(record);
    if (apply) {
      return enqueue(record, {
        owner: { actor: 'external', viewerId }, config: null, apply,
        isCurrent: () => record.devtools.has(devtoolsId) && record.devtools.get(devtoolsId) === viewerId,
      });
    }
    await observeRecord(record);
  };

  const detachViewer = (sessionId, viewerId, targetId) => {
    const record = getRecord(sessionId, targetId, false);
    if (!record) return;
    if (record.pending?.owner.viewerId === viewerId) settle(record, record.pending, failure('STALE_ATTACHMENT'));
    if (record.inFlight?.owner.viewerId === viewerId) settle(record, record.inFlight, failure('STALE_ATTACHMENT'));
    if (record.owner?.actor === 'viewer' && record.owner.viewerId === viewerId && record.owner.mode === 'auto') {
      record.owner = null;
      record.observationEpoch += 1;
      publish(record);
    }
  };

  const dropTarget = (sessionId, targetId) => {
    const record = getRecord(sessionId, targetId, false);
    if (!record) return;
    record.disposed = true;
    if (record.pending) settle(record, record.pending, failure('STALE_ATTACHMENT'));
    if (record.inFlight) settle(record, record.inFlight, failure('STALE_ATTACHMENT'));
    sessions.get(sessionId).delete(targetId);
    if (sessions.get(sessionId).size === 0) sessions.delete(sessionId);
  };

  browserSessionManager.onControlChange(({ sessionId }) => {
    for (const record of sessions.get(sessionId)?.values() ?? []) publish(record);
  });
  browserSessionManager.onLifecycle(({ type, sessionId }) => {
    if (type !== 'ended') return;
    for (const targetId of sessions.get(sessionId)?.keys() ?? []) dropTarget(sessionId, targetId);
  });

  return {
    snapshot: (sessionId, targetId, viewerId) => snapshotOf(getRecord(sessionId, targetId, false), viewerId),
    read, setViewer, applyAgent, external, detachViewer, dropTarget,
    observe: (sessionId, targetId) => observeRecord(getRecord(sessionId, targetId)),
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
};

export const getBrowserViewportManager = (browserSessionManager) => {
  if (!managers.has(browserSessionManager)) managers.set(browserSessionManager, createViewportManager(browserSessionManager));
  return managers.get(browserSessionManager);
};
