import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  GitExecutionCancelledError,
  GitExecutionOverloadedError,
  GitExecutionQueueTimeoutError,
  GitExecutionReentrancyError,
} from './execution-errors.js';

export const GIT_OPERATION_KIND = Object.freeze({
  READ: 'read',
  WORKTREE_WRITE: 'worktree-write',
  COMMON_WRITE: 'common-write',
  TOPOLOGY_WRITE: 'topology-write',
});

export const GIT_READ_ONLY_ENV = Object.freeze({ GIT_OPTIONAL_LOCKS: '0' });

const kinds = new Set(Object.values(GIT_OPERATION_KIND));
const cloneLeaseEntries = new WeakMap();

const DEFAULT_LIMITS = Object.freeze({
  globalConcurrency: 32,
  readsPerCommonContext: 8,
  networkPerCommonContext: 4,
  globalNetworkConcurrency: 8,
  maxQueuePerContext: 128,
  maxGlobalQueue: 512,
  maxContexts: 256,
  maxWorktrees: 1024,
  maxStatusInFlight: 128,
  maxCloneQueue: 64,
  maxCloneQueuePerDestination: 8,
  maxCloneDestinations: 128,
  idleTtlMs: 5 * 60 * 1000,
  idlePruneIntervalMs: 30 * 1000,
});

const positiveLimit = (value, fallback, allowZero = false) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const rounded = Math.floor(parsed);
  return Math.max(allowZero ? 0 : 1, rounded);
};

const normalizeLimits = (options = {}) => Object.freeze({
  globalConcurrency: positiveLimit(options.globalConcurrency, DEFAULT_LIMITS.globalConcurrency),
  readsPerCommonContext: positiveLimit(options.readsPerCommonContext, DEFAULT_LIMITS.readsPerCommonContext),
  networkPerCommonContext: positiveLimit(options.networkPerCommonContext, DEFAULT_LIMITS.networkPerCommonContext),
  globalNetworkConcurrency: positiveLimit(options.globalNetworkConcurrency, DEFAULT_LIMITS.globalNetworkConcurrency),
  maxQueuePerContext: positiveLimit(options.maxQueuePerContext, DEFAULT_LIMITS.maxQueuePerContext, true),
  maxGlobalQueue: positiveLimit(options.maxGlobalQueue, DEFAULT_LIMITS.maxGlobalQueue, true),
  maxContexts: positiveLimit(options.maxContexts, DEFAULT_LIMITS.maxContexts),
  maxWorktrees: positiveLimit(options.maxWorktrees, DEFAULT_LIMITS.maxWorktrees),
  maxStatusInFlight: positiveLimit(options.maxStatusInFlight, DEFAULT_LIMITS.maxStatusInFlight),
  maxCloneQueue: positiveLimit(options.maxCloneQueue, DEFAULT_LIMITS.maxCloneQueue, true),
  maxCloneQueuePerDestination: positiveLimit(options.maxCloneQueuePerDestination, DEFAULT_LIMITS.maxCloneQueuePerDestination, true),
  maxCloneDestinations: positiveLimit(options.maxCloneDestinations, DEFAULT_LIMITS.maxCloneDestinations),
  idleTtlMs: positiveLimit(options.idleTtlMs, DEFAULT_LIMITS.idleTtlMs, true),
  idlePruneIntervalMs: positiveLimit(options.idlePruneIntervalMs, DEFAULT_LIMITS.idlePruneIntervalMs, true),
});

const nowValue = (now) => {
  const value = Number(now());
  return Number.isFinite(value) ? value : Date.now();
};

const contextKey = (context) => `${context.commonId}\0${context.worktreeId}`;

const ensureContext = (context) => {
  if (!context || context.isRepository !== true) {
    throw new TypeError('A repository execution context is required');
  }
  if (typeof context.commonId !== 'string' || !context.commonId.trim()) {
    throw new TypeError('commonId is required');
  }
  if (typeof context.worktreeId !== 'string' || !context.worktreeId.trim()) {
    throw new TypeError('worktreeId is required');
  }
};

const ensureKind = (kind) => {
  if (!kinds.has(kind)) {
    throw new TypeError(`Unknown Git operation kind: ${String(kind)}`);
  }
};

const isRead = (kind) => kind === GIT_OPERATION_KIND.READ;
const isCommonBarrier = (kind) => (
  kind === GIT_OPERATION_KIND.COMMON_WRITE || kind === GIT_OPERATION_KIND.TOPOLOGY_WRITE
);

const operationTargetsSameWorktree = (left, right) => (
  Boolean(left.targetWorktree) && Boolean(right.targetWorktree)
  && left.context.worktreeId === right.context.worktreeId
);

const potentiallyConflicts = (left, right) => {
  if (left.context.commonId !== right.context.commonId) {
    return false;
  }
  if (isCommonBarrier(left.kind) || isCommonBarrier(right.kind)) {
    return true;
  }
  if (isRead(left.kind) && isRead(right.kind)) {
    return false;
  }
  return operationTargetsSameWorktree(left, right);
};

const compatibleLease = (held, requested) => {
  if (held.commonId !== requested.context.commonId || held.worktreeId !== requested.context.worktreeId) {
    return false;
  }
  if (requested.network && !held.network) {
    return false;
  }
  if (held.kind === GIT_OPERATION_KIND.TOPOLOGY_WRITE) {
    return true;
  }
  if (held.kind === GIT_OPERATION_KIND.COMMON_WRITE) {
    return requested.context.commonId === held.commonId;
  }
  if (held.kind === GIT_OPERATION_KIND.WORKTREE_WRITE) {
    return requested.kind === GIT_OPERATION_KIND.READ
      || requested.kind === GIT_OPERATION_KIND.WORKTREE_WRITE;
  }
  return requested.kind === GIT_OPERATION_KIND.READ;
};

const cancellationError = (signal, message) => new GitExecutionCancelledError(
  message,
  { reason: signal?.reason },
);

const canonicalizeMissingPath = async (destination) => {
  // Clone reservations happen before the destination exists. Resolve the
  // nearest existing ancestor so symlinked parent aliases share one key.
  const resolved = path.resolve(destination);
  const missingParts = [];
  let current = resolved;

  while (true) {
    try {
      const canonical = await fsp.realpath(current);
      return path.join(path.resolve(canonical), ...missingParts.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw error;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      missingParts.push(path.basename(current));
      current = parent;
    }
  }
};

export class GitExecutionCoordinator {
  constructor(options = {}) {
    this.limits = normalizeLimits(options);
    this.now = options.now || Date.now;
    this.setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer || ((handle) => clearTimeout(handle));
    this.canonicalizeCloneDestination = options.canonicalizeCloneDestination
      || canonicalizeMissingPath;
    this.contexts = new Map();
    this.pending = [];
    this.activeEntries = new Set();
    this.activeNetwork = 0;
    this.statusInFlight = new Map();
    this.cloneDestinations = new Map();
    this.clonePending = [];
    this.cloneActive = new Set();
    this.nextEntryId = 1;
    this.lastPruneAt = 0;
    this.draining = false;
  }

  createContextState(commonId) {
    const current = this.contexts.get(commonId);
    if (current) {
      current.lastUsed = nowValue(this.now);
      return current;
    }
    if (this.contexts.size >= this.limits.maxContexts) {
      this.pruneIdle({ force: true });
    }
    if (this.contexts.size >= this.limits.maxContexts) {
      throw new GitExecutionOverloadedError(
        'Git execution context capacity is exhausted',
        { maxContexts: this.limits.maxContexts },
      );
    }
    const state = {
      commonId,
      worktrees: new Map(),
      active: new Set(),
      pending: 0,
      activeReads: 0,
      activeNetwork: 0,
      generation: 0,
      lastCommonMutationId: 0,
      lastUsed: nowValue(this.now),
    };
    this.contexts.set(commonId, state);
    return state;
  }

  createWorktreeState(contextState, worktreeId) {
    const current = contextState.worktrees.get(worktreeId);
    if (current) {
      current.lastUsed = nowValue(this.now);
      return current;
    }
    if (this.worktreeCount() >= this.limits.maxWorktrees) {
      this.pruneIdle({ force: true });
      if (this.worktreeCount() >= this.limits.maxWorktrees) {
        throw new GitExecutionOverloadedError(
          'Git execution worktree capacity is exhausted',
          { maxWorktrees: this.limits.maxWorktrees },
        );
      }
    }
    const state = {
      worktreeId,
      active: new Set(),
      pending: 0,
      generation: 0,
      lastMutationId: 0,
      lastUsed: nowValue(this.now),
    };
    contextState.worktrees.set(worktreeId, state);
    return state;
  }

  worktreeCount() {
    let total = 0;
    for (const state of this.contexts.values()) {
      total += state.worktrees.size;
    }
    return total;
  }

  getOrCreateStates(context) {
    ensureContext(context);
    const hadContext = this.contexts.has(context.commonId);
    const hadWorktree = hadContext && this.contexts.get(context.commonId).worktrees.has(context.worktreeId);
    const contextState = this.createContextState(context.commonId);
    const worktreeState = this.createWorktreeState(contextState, context.worktreeId);
    return {
      contextState,
      worktreeState,
      createdContext: !hadContext,
      createdWorktree: !hadWorktree,
    };
  }

  getGeneration(context) {
    ensureContext(context);
    const contextState = this.contexts.get(context.commonId);
    const worktreeState = contextState?.worktrees.get(context.worktreeId);
    return {
      common: contextState?.generation || 0,
      worktree: worktreeState?.generation || 0,
    };
  }

  invalidateWorktrees(commonId, worktreeIds) {
    if (typeof commonId !== 'string' || !commonId.trim() || !Array.isArray(worktreeIds)) {
      return 0;
    }
    const contextState = this.contexts.get(commonId);
    if (!contextState) {
      return 0;
    }
    let removed = 0;
    for (const worktreeId of worktreeIds) {
      const state = contextState.worktrees.get(worktreeId);
      if (!state || state.active.size > 0 || state.pending > 0) {
        continue;
      }
      contextState.worktrees.delete(worktreeId);
      removed += 1;
    }
    if (contextState.worktrees.size === 0 && contextState.active.size === 0 && contextState.pending === 0) {
      this.contexts.delete(commonId);
    }
    return removed;
  }

  entryCanStart(entry) {
    if (this.activeEntries.size + this.cloneActive.size >= this.limits.globalConcurrency) {
      return false;
    }
    if (entry.network && this.activeNetwork >= this.limits.globalNetworkConcurrency) {
      return false;
    }
    const contextState = entry.contextState;
    if (entry.network && contextState.activeNetwork >= this.limits.networkPerCommonContext) {
      return false;
    }
    if (isRead(entry.kind) && contextState.activeReads >= this.limits.readsPerCommonContext) {
      return false;
    }
    for (const active of contextState.active) {
      if (potentiallyConflicts(entry, active)) {
        return false;
      }
    }
    return true;
  }

  blockedByEarlierWriter(entry, queue) {
    for (const earlier of queue) {
      if (earlier === entry || earlier.cancelled) {
        if (earlier === entry) {
          break;
        }
        continue;
      }
      if (potentiallyConflicts(earlier, entry) && !isRead(earlier.kind)) {
        return true;
      }
    }
    return false;
  }

  canStartEntry(entry) {
    return !this.blockedByEarlierWriter(entry, this.pending) && this.entryCanStart(entry);
  }

  clearEntryTimer(entry) {
    if (entry.timer !== undefined) {
      this.clearTimer(entry.timer);
      entry.timer = undefined;
    }
  }

  settleEntry(entry, method, value) {
    if (entry.settled) {
      return;
    }
    entry.settled = true;
    this.clearEntryTimer(entry);
    method(value);
  }

  removePendingEntry(entry) {
    const index = this.pending.indexOf(entry);
    if (index !== -1) {
      this.pending.splice(index, 1);
    }
    entry.cancelled = true;
    entry.contextState.pending = Math.max(0, entry.contextState.pending - 1);
    entry.worktreeState.pending = Math.max(0, entry.worktreeState.pending - 1);
    this.clearEntryTimer(entry);
    this.cleanupIdleState(entry.contextState, entry.worktreeState);
    this.removeUnusedStates(entry);
  }

  addMutationGeneration(entry) {
    if (isRead(entry.kind)) {
      return;
    }
    if (isCommonBarrier(entry.kind)) {
      entry.contextState.generation += 1;
      return;
    }
    entry.worktreeState.generation += 1;
  }

  recordMutationOrder(entry) {
    if (isRead(entry.kind)) {
      return;
    }
    if (isCommonBarrier(entry.kind)) {
      entry.contextState.lastCommonMutationId = entry.id;
      return;
    }
    entry.worktreeState.lastMutationId = entry.id;
  }

  releaseMutationGeneration(entry) {
    if (isRead(entry.kind)) {
      return;
    }
    if (isCommonBarrier(entry.kind)) {
      entry.contextState.generation += 1;
      return;
    }
    entry.worktreeState.generation += 1;
  }

  startEntry(entry) {
    entry.started = true;
    this.clearEntryTimer(entry);
    this.activeEntries.add(entry);
    entry.contextState.active.add(entry);
    entry.contextState.activeReads += isRead(entry.kind) ? 1 : 0;
    entry.contextState.activeNetwork += entry.network ? 1 : 0;
    entry.worktreeState.active.add(entry);
    this.activeNetwork += entry.network ? 1 : 0;
    this.addMutationGeneration(entry);
    this.recordMutationOrder(entry);
    const lease = {
      commonId: entry.context.commonId,
      worktreeId: entry.context.worktreeId,
      kind: entry.kind,
      targetWorktree: entry.targetWorktree,
      network: entry.network,
      active: true,
    };
    entry.lease = lease;
    Promise.resolve()
      .then(() => entry.task(lease))
      .then(
        (value) => this.settleEntry(entry, entry.resolve, value),
        (error) => this.settleEntry(entry, entry.reject, error),
      )
      .finally(() => {
        lease.active = false;
        this.activeEntries.delete(entry);
        entry.contextState.active.delete(entry);
        entry.contextState.activeReads = Math.max(0, entry.contextState.activeReads - (isRead(entry.kind) ? 1 : 0));
        entry.contextState.activeNetwork = Math.max(0, entry.contextState.activeNetwork - (entry.network ? 1 : 0));
        entry.worktreeState.active.delete(entry);
        this.activeNetwork = Math.max(0, this.activeNetwork - (entry.network ? 1 : 0));
        this.releaseMutationGeneration(entry);
        entry.contextState.lastUsed = nowValue(this.now);
        entry.worktreeState.lastUsed = nowValue(this.now);
        this.cleanupIdleState(entry.contextState, entry.worktreeState);
        this.drain();
      });
  }

  createEntry(options, task) {
    const {
      contextState,
      worktreeState,
      createdContext,
      createdWorktree,
    } = this.getOrCreateStates(options.context);
    const kind = options.kind;
    ensureKind(kind);
    const entry = {
      id: this.nextEntryId++,
      context: options.context,
      contextState,
      worktreeState,
      createdContext,
      createdWorktree,
      kind,
      targetWorktree: options.targetWorktree ?? !isCommonBarrier(kind),
      network: options.network === true,
      task,
      label: options.label,
      signal: options.signal,
      resolve: null,
      reject: null,
      settled: false,
      started: false,
      cancelled: false,
      timer: undefined,
    };
    return entry;
  }

  enqueueEntry(entry, queueTimeoutMs) {
    if (entry.signal?.aborted) {
      this.removeUnusedStates(entry);
      return Promise.reject(cancellationError(entry.signal, 'Git execution was cancelled before admission'));
    }
    const queueFull = entry.contextState.pending >= this.limits.maxQueuePerContext
      || this.pending.length >= this.limits.maxGlobalQueue;
    if (queueFull && !this.canStartEntry(entry)) {
      this.removeUnusedStates(entry);
      return Promise.reject(new GitExecutionOverloadedError(
        'Git execution queue is overloaded',
        {
          context: entry.context.commonId,
          pending: this.pending.length,
          contextPending: entry.contextState.pending,
          maxQueuePerContext: this.limits.maxQueuePerContext,
          maxGlobalQueue: this.limits.maxGlobalQueue,
        },
      ));
    }

    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
      const onAbort = () => {
        if (entry.started) {
          this.settleEntry(entry, reject, cancellationError(entry.signal, 'Git execution was cancelled'));
          return;
        }
        this.removePendingEntry(entry);
        this.settleEntry(entry, reject, cancellationError(entry.signal, 'Git execution was cancelled while queued'));
        this.drain();
      };
      entry.onAbort = onAbort;
      if (entry.signal) {
        entry.signal.addEventListener('abort', onAbort, { once: true });
      }
      if (Number.isFinite(queueTimeoutMs) && queueTimeoutMs >= 0) {
        entry.timer = this.setTimer(() => {
          if (entry.started || entry.cancelled) {
            return;
          }
          this.removePendingEntry(entry);
          this.settleEntry(entry, reject, new GitExecutionQueueTimeoutError(
            'Git execution queue wait timed out',
            { label: entry.label, queueTimeoutMs },
          ));
          this.drain();
        }, queueTimeoutMs);
      }
      this.pending.push(entry);
      entry.contextState.pending += 1;
      entry.worktreeState.pending += 1;
      this.drain();
    });
    return promise.finally(() => {
      entry.signal?.removeEventListener('abort', entry.onAbort);
    });
  }

  run(options, task) {
    if (!options || typeof task !== 'function') {
      return Promise.reject(new TypeError('Git execution options and task are required'));
    }
    try {
      ensureContext(options.context);
      ensureKind(options.kind);
    } catch (error) {
      return Promise.reject(error);
    }

    if (options.lease) {
      const lease = options.lease;
      if (lease.kind === 'clone-reservation') {
        const entry = cloneLeaseEntries.get(lease);
        if (!entry || !lease.active || !this.cloneActive.has(entry)) {
          return Promise.reject(new GitExecutionReentrancyError(
            'Git execution attempted an inactive clone lease re-entry',
            { kind: options.kind, worktreeId: options.context.worktreeId },
          ));
        }
        return Promise.resolve().then(() => task(lease));
      }
      if (!lease.active || !compatibleLease(lease, options)) {
        return Promise.reject(new GitExecutionReentrancyError(
          'Git execution attempted incompatible lease re-entry',
          { kind: options.kind, worktreeId: options.context.worktreeId },
        ));
      }
      return Promise.resolve().then(() => task(lease));
    }

    let entry;
    try {
      entry = this.createEntry(options, task);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueueEntry(entry, options.queueTimeoutMs);
  }

  statusBaseKey(context, generation) {
    return `${context.commonId}\0${context.worktreeId}\0${generation.common}\0${generation.worktree}`;
  }

  latestMutationId(context) {
    const contextState = this.contexts.get(context.commonId);
    const worktreeState = contextState?.worktrees.get(context.worktreeId);
    return Math.max(contextState?.lastCommonMutationId || 0, worktreeState?.lastMutationId || 0);
  }

  hasLaterPendingMutation(operationId, context) {
    const statusOperation = {
      context,
      kind: GIT_OPERATION_KIND.READ,
      targetWorktree: true,
    };
    return this.pending.some((entry) => entry.id > operationId
      && !entry.cancelled
      && !isRead(entry.kind)
      && potentiallyConflicts(entry, statusOperation));
  }

  canReuseStatusSource(entry, baseKey, context) {
    if (entry.context.commonId !== context.commonId || entry.context.worktreeId !== context.worktreeId) {
      return false;
    }
    if (entry.sourceAbortRequested || entry.controller.signal.aborted) {
      return false;
    }
    if (this.hasLaterPendingMutation(entry.operationId, context)) {
      return false;
    }
    return entry.baseKey === baseKey || entry.operationId > this.latestMutationId(context);
  }

  finishStatusSource(key, entry) {
    if (entry.sourceCompleted) {
      return;
    }
    entry.sourceCompleted = true;
    if (this.statusInFlight.get(key) === entry) {
      this.statusInFlight.delete(key);
    }
  }

  releaseStatusWaiter(entry, reason) {
    entry.waiters = Math.max(0, entry.waiters - 1);
    if (entry.waiters !== 0 || entry.sourceCompleted || entry.sourceAbortRequested) {
      return;
    }
    entry.sourceAbortRequested = true;
    entry.controller.abort(reason || 'Git status source is no longer needed');
  }

  waitForStatus(entry, projected, signal) {
    entry.waiters += 1;
    if (!signal) {
      return projected.finally(() => this.releaseStatusWaiter(entry));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (method, value) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        this.releaseStatusWaiter(entry, signal.reason);
        method(value);
      };
      const onAbort = () => finish(
        reject,
        cancellationError(signal, 'Git status waiter was cancelled'),
      );

      signal.addEventListener('abort', onAbort, { once: true });
      projected.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  projectStatus(value, requestedShape, sourceShape, projectResult) {
    return typeof projectResult === 'function'
      ? projectResult(value, requestedShape, sourceShape)
      : value;
  }

  runStatus(options, task) {
    if (!options || typeof task !== 'function') {
      return Promise.reject(new TypeError('Git status options and task are required'));
    }
    let generation;
    try {
      ensureContext(options.context);
      generation = this.getGeneration(options.context);
    } catch (error) {
      return Promise.reject(error);
    }
    if (options.signal?.aborted) {
      return Promise.reject(cancellationError(options.signal, 'Git status was cancelled before admission'));
    }
    const requestedShape = options.shape === 'light' ? 'light' : 'full';
    const baseKey = this.statusBaseKey(options.context, generation);
    const sourceEntry = Array.from(this.statusInFlight.values()).find((entry) => (
      (entry.shape === 'full' || entry.shape === requestedShape)
      && this.canReuseStatusSource(entry, baseKey, options.context)
    ));

    const waitFor = sourceEntry || (() => {
      if (this.statusInFlight.size >= this.limits.maxStatusInFlight) {
        return null;
      }
      const shape = requestedShape;
      const operationId = this.nextEntryId;
      const key = `${baseKey}\0${shape}\0${operationId}`;
      const controller = new AbortController();
      const entry = {
        context: options.context,
        baseKey,
        shape,
        operationId,
        controller,
        waiters: 0,
        sourceAbortRequested: false,
        sourceStarted: false,
        sourceCompleted: false,
        promise: null,
      };
      const sourceTask = () => {
        entry.sourceStarted = true;
        entry.baseKey = this.statusBaseKey(options.context, this.getGeneration(options.context));
        return Promise.resolve()
          .then(() => task(shape, controller.signal))
          .finally(() => this.finishStatusSource(key, entry));
      };
      entry.promise = this.run({
        context: options.context,
        kind: GIT_OPERATION_KIND.READ,
        targetWorktree: true,
        label: options.label || `status:${shape}`,
        queueTimeoutMs: options.queueTimeoutMs,
        signal: controller.signal,
      }, sourceTask);
      this.statusInFlight.set(key, entry);
      entry.promise.then(
        () => {
          if (!entry.sourceStarted) {
            this.finishStatusSource(key, entry);
          }
        },
        () => {
          if (!entry.sourceStarted) {
            this.finishStatusSource(key, entry);
          }
        },
      );
      return entry;
    })();

    if (!waitFor) {
      return Promise.reject(new GitExecutionOverloadedError(
        'Git status queue is overloaded',
        { maxStatusInFlight: this.limits.maxStatusInFlight },
      ));
    }
    const projected = waitFor.promise.then((value) => this.projectStatus(
      value,
      requestedShape,
      waitFor.shape,
      options.projectResult,
    ));
    return this.waitForStatus(waitFor, projected, options.signal);
  }

  canonicalCloneKey(destination) {
    if (typeof destination !== 'string' || !destination.trim()) {
      throw new TypeError('Clone destination is required');
    }
    return this.canonicalizeCloneDestination(destination.trim());
  }

  cloneCanStart(entry) {
    return this.activeEntries.size + this.cloneActive.size < this.limits.globalConcurrency
      && this.activeNetwork < this.limits.globalNetworkConcurrency
      && !entry.destinationState.active;
  }

  startClone(entry) {
    entry.started = true;
    this.clearEntryTimer(entry);
    this.cloneActive.add(entry);
    entry.destinationState.active = true;
    this.activeNetwork += 1;
    const lease = {
      kind: 'clone-reservation',
      destinationId: entry.destinationId,
      network: true,
      active: true,
      releaseNetwork: () => {
        if (!lease.network) {
          return;
        }
        lease.network = false;
        this.activeNetwork = Math.max(0, this.activeNetwork - 1);
        this.drain();
      },
    };
    entry.lease = lease;
    cloneLeaseEntries.set(lease, entry);
    Promise.resolve()
      .then(() => entry.task(lease))
      .then(
        (value) => this.settleEntry(entry, entry.resolve, value),
        (error) => this.settleEntry(entry, entry.reject, error),
      )
      .finally(() => {
        lease.releaseNetwork();
        lease.active = false;
        cloneLeaseEntries.delete(lease);
        this.cloneActive.delete(entry);
        entry.destinationState.active = false;
        entry.destinationState.pending = Math.max(0, entry.destinationState.pending - 1);
        if (entry.destinationState.pending === 0 && !entry.destinationState.active) {
          this.cloneDestinations.delete(entry.destinationId);
        }
        this.drain();
      });
  }

  removePendingClone(entry) {
    const index = this.clonePending.indexOf(entry);
    if (index !== -1) {
      this.clonePending.splice(index, 1);
    }
    entry.cancelled = true;
    entry.destinationState.pending = Math.max(0, entry.destinationState.pending - 1);
    entry.destinationState.queued = Math.max(0, entry.destinationState.queued - 1);
    if (entry.destinationState.pending === 0 && !entry.destinationState.active) {
      this.cloneDestinations.delete(entry.destinationId);
    }
    this.clearEntryTimer(entry);
  }

  enqueueClone(destinationId, options, task) {
    if (options.signal?.aborted) {
      return Promise.reject(cancellationError(options.signal, 'Git clone was cancelled before admission'));
    }
    const existing = this.cloneDestinations.get(destinationId);
    let destinationState = existing;
    if (!destinationState) {
      if (this.cloneDestinations.size >= this.limits.maxCloneDestinations) {
        return Promise.reject(new GitExecutionOverloadedError(
          'Git clone destination capacity is exhausted',
          { maxCloneDestinations: this.limits.maxCloneDestinations },
        ));
      }
      destinationState = { destinationId, active: false, pending: 0, queued: 0 };
      this.cloneDestinations.set(destinationId, destinationState);
    }
    if (destinationState.queued >= this.limits.maxCloneQueuePerDestination
      || this.clonePending.length >= this.limits.maxCloneQueue) {
      if (!destinationState.active && destinationState.pending === 0) {
        this.cloneDestinations.delete(destinationId);
      }
      return Promise.reject(new GitExecutionOverloadedError(
        'Git clone queue is overloaded',
        { destinationId, maxCloneQueue: this.limits.maxCloneQueue },
      ));
    }

    const entry = {
      id: this.nextEntryId++,
      destinationId,
      destinationState,
      task,
      signal: options.signal,
      label: options.label,
      resolve: null,
      reject: null,
      settled: false,
      started: false,
      cancelled: false,
      timer: undefined,
    };
    destinationState.pending += 1;
    destinationState.queued += 1;
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
      const onAbort = () => {
        if (entry.started) {
          // The started task owns process termination and cleanup. Let its
          // close lifecycle settle the clone so the reservation is not
          // released before the destination cleanup completes.
          return;
        }
        this.removePendingClone(entry);
        this.settleEntry(entry, reject, cancellationError(entry.signal, 'Git clone was cancelled while queued'));
        this.drain();
      };
      entry.onAbort = onAbort;
      entry.signal?.addEventListener('abort', onAbort, { once: true });
      if (Number.isFinite(options.queueTimeoutMs) && options.queueTimeoutMs >= 0) {
        entry.timer = this.setTimer(() => {
          if (entry.started || entry.cancelled) {
            return;
          }
          this.removePendingClone(entry);
          this.settleEntry(entry, reject, new GitExecutionQueueTimeoutError(
            'Git clone queue wait timed out',
            { destinationId, queueTimeoutMs: options.queueTimeoutMs },
          ));
          this.drain();
        }, options.queueTimeoutMs);
      }
      this.clonePending.push(entry);
      this.drain();
    });
    return promise.finally(() => entry.signal?.removeEventListener('abort', entry.onAbort));
  }

  runClone(options, task) {
    if (!options || typeof task !== 'function') {
      return Promise.reject(new TypeError('Clone options and task are required'));
    }
    if (options.signal?.aborted) {
      return Promise.reject(cancellationError(options.signal, 'Git clone was cancelled before admission'));
    }
    return Promise.resolve(this.canonicalCloneKey(options.destination)).then((destinationId) => {
      if (typeof destinationId !== 'string' || !destinationId.trim()) {
        throw new TypeError('Canonical clone destination is required');
      }
      return this.enqueueClone(destinationId, options, task);
    });
  }

  cleanupIdleState(contextState, worktreeState) {
    const timestamp = nowValue(this.now);
    contextState.lastUsed = Math.max(contextState.lastUsed, timestamp);
    worktreeState.lastUsed = Math.max(worktreeState.lastUsed, timestamp);
  }

  removeUnusedStates(entry) {
    if (entry.worktreeState.active.size === 0 && entry.worktreeState.pending === 0
      && entry.createdWorktree) {
      entry.contextState.worktrees.delete(entry.worktreeState.worktreeId);
    }
    if (entry.contextState.active.size === 0 && entry.contextState.pending === 0
      && entry.contextState.worktrees.size === 0 && entry.createdContext) {
      this.contexts.delete(entry.contextState.commonId);
    }
  }

  pruneIdle(options = {}) {
    const timestamp = nowValue(this.now);
    if (!options.force && timestamp - this.lastPruneAt < this.limits.idlePruneIntervalMs) {
      return;
    }
    this.lastPruneAt = timestamp;
    for (const [commonId, contextState] of this.contexts) {
      for (const [worktreeId, worktreeState] of contextState.worktrees) {
        if (worktreeState.active.size === 0 && worktreeState.pending === 0
          && (options.force || timestamp - worktreeState.lastUsed >= this.limits.idleTtlMs)) {
          contextState.worktrees.delete(worktreeId);
        }
      }
      if (contextState.active.size === 0 && contextState.pending === 0 && contextState.worktrees.size === 0
        && (options.force || timestamp - contextState.lastUsed >= this.limits.idleTtlMs)) {
        this.contexts.delete(commonId);
      }
    }
  }

  drain() {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      let madeProgress = true;
      while (madeProgress) {
        madeProgress = false;
        this.pruneIdle();
        const operationSnapshot = [...this.pending];
        for (const entry of operationSnapshot) {
          if (entry.cancelled) {
            continue;
          }
          if (!this.canStartEntry(entry)) {
            continue;
          }
          const index = this.pending.indexOf(entry);
          if (index === -1) {
            continue;
          }
          this.pending.splice(index, 1);
          entry.contextState.pending = Math.max(0, entry.contextState.pending - 1);
          entry.worktreeState.pending = Math.max(0, entry.worktreeState.pending - 1);
          this.startEntry(entry);
          madeProgress = true;
        }
        const cloneSnapshot = [...this.clonePending];
        for (const entry of cloneSnapshot) {
          if (entry.cancelled || !this.cloneCanStart(entry)) {
            continue;
          }
          const index = this.clonePending.indexOf(entry);
          if (index === -1) {
            continue;
          }
          this.clonePending.splice(index, 1);
          entry.destinationState.queued = Math.max(0, entry.destinationState.queued - 1);
          this.startClone(entry);
          madeProgress = true;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  getStats() {
    let idleContexts = 0;
    for (const contextState of this.contexts.values()) {
      if (contextState.active.size === 0 && contextState.pending === 0) {
        idleContexts += 1;
      }
    }
    return {
      active: this.activeEntries.size + this.cloneActive.size,
      pending: this.pending.length,
      activeNetwork: this.activeNetwork,
      contexts: this.contexts.size,
      idleContexts,
      worktrees: this.worktreeCount(),
      statusInFlight: this.statusInFlight.size,
      clonePending: this.clonePending.length,
      cloneDestinations: this.cloneDestinations.size,
      limits: this.limits,
    };
  }
}

export const createGitExecutionCoordinator = (options) => new GitExecutionCoordinator(options);
