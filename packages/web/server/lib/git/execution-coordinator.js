import fs from 'node:fs';
import os from 'node:os';
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

const defaultGlobalConcurrency = () => {
  const available = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.min(8, Math.max(2, Number.isFinite(available) ? available : 2));
};

const DEFAULT_GIT_EXECUTION_LIMITS = Object.freeze({
  globalConcurrency: defaultGlobalConcurrency(),
  readsPerCommonContext: 2,
  networkPerCommonContext: 1,
  globalNetworkConcurrency: 2,
  maxQueuePerContext: 64,
  maxGlobalQueue: 2048,
  maxContexts: 512,
  maxWorktrees: 4096,
  maxStatusInFlight: 2048,
  maxCloneQueue: 256,
  maxCloneQueuePerDestination: 16,
  maxCloneDestinations: 256,
  idleTtlMs: 30_000,
  idlePruneIntervalMs: 1_000,
});

const NO_EXECUTION_ERROR = Symbol('no-execution-error');

const asPositiveInteger = (value, fallback, name) => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
};

const asNonNegativeInteger = (value, fallback, name) => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return resolved;
};

const asOptionalPositiveInteger = (value, name) => {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer when provided`);
  }
  return value;
};

const defaultCanonicalizeCloneDestination = async (destination) => {
  if (typeof destination !== 'string' || !destination.trim()) {
    throw new TypeError('A clone destination is required');
  }
  const absolute = path.resolve(destination.trim());
  const canonical = await fs.promises.realpath(absolute).catch(async () => {
    const parent = path.dirname(absolute);
    const canonicalParent = await fs.promises.realpath(parent).catch(() => parent);
    return path.join(canonicalParent, path.basename(absolute));
  });
  const normalized = path.normalize(canonical);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const waitForSharedPromise = (promise, signal, label) => {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(new GitExecutionCancelledError(`${label} was cancelled`));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new GitExecutionCancelledError(`${label} was cancelled`));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

const operationIsMutation = (kind) => kind !== GIT_OPERATION_KIND.READ;

const operationClaimsWorktree = (kind, targetWorktree = false) => (
  kind === GIT_OPERATION_KIND.READ
  || kind === GIT_OPERATION_KIND.WORKTREE_WRITE
  || (kind === GIT_OPERATION_KIND.COMMON_WRITE && targetWorktree)
);

const validateContext = (context, kind, targetWorktree = false) => {
  if (!context?.isRepository || !context.commonId) {
    throw new TypeError('A resolved Git repository context is required');
  }
  if (operationClaimsWorktree(kind, targetWorktree) && !context.worktreeId) {
    throw new TypeError('A worktree identity is required for local Git execution');
  }
};

const validateKind = (kind) => {
  if (!Object.values(GIT_OPERATION_KIND).includes(kind)) {
    throw new TypeError(`Unknown Git operation kind: ${kind}`);
  }
};

const createContextState = (commonId, now) => ({
  commonId,
  pending: [],
  activeCount: 0,
  activeReads: 0,
  activeReadsByWorktree: new Map(),
  activeWorktreeWrites: new Set(),
  activeCommonWrite: false,
  activeTopologyWrite: false,
  activeNetwork: 0,
  commonGeneration: 0,
  worktrees: new Map(),
  lastUsedAt: now,
  idleSince: now,
});

const createWorktreeState = (worktreeId, now) => ({
  worktreeId,
  generation: 0,
  pendingCount: 0,
  activeCount: 0,
  lastUsedAt: now,
});

const createCloneDestinationState = (destinationId, now) => ({
  destinationId,
  pendingCount: 0,
  activeCount: 0,
  lastUsedAt: now,
});

export class GitExecutionCoordinator {
  constructor({
    globalConcurrency = DEFAULT_GIT_EXECUTION_LIMITS.globalConcurrency,
    readsPerCommonContext = DEFAULT_GIT_EXECUTION_LIMITS.readsPerCommonContext,
    networkPerCommonContext = DEFAULT_GIT_EXECUTION_LIMITS.networkPerCommonContext,
    globalNetworkConcurrency = DEFAULT_GIT_EXECUTION_LIMITS.globalNetworkConcurrency,
    maxQueuePerContext = DEFAULT_GIT_EXECUTION_LIMITS.maxQueuePerContext,
    maxGlobalQueue = DEFAULT_GIT_EXECUTION_LIMITS.maxGlobalQueue,
    maxContexts = DEFAULT_GIT_EXECUTION_LIMITS.maxContexts,
    maxWorktrees = DEFAULT_GIT_EXECUTION_LIMITS.maxWorktrees,
    maxStatusInFlight = DEFAULT_GIT_EXECUTION_LIMITS.maxStatusInFlight,
    maxCloneQueue = DEFAULT_GIT_EXECUTION_LIMITS.maxCloneQueue,
    maxCloneQueuePerDestination = DEFAULT_GIT_EXECUTION_LIMITS.maxCloneQueuePerDestination,
    maxCloneDestinations = DEFAULT_GIT_EXECUTION_LIMITS.maxCloneDestinations,
    idleTtlMs = DEFAULT_GIT_EXECUTION_LIMITS.idleTtlMs,
    idlePruneIntervalMs = DEFAULT_GIT_EXECUTION_LIMITS.idlePruneIntervalMs,
    now = Date.now,
    canonicalizeCloneDestination = defaultCanonicalizeCloneDestination,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    if (typeof canonicalizeCloneDestination !== 'function') {
      throw new TypeError('canonicalizeCloneDestination must be a function');
    }
    if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
      throw new TypeError('setTimer and clearTimer must be functions');
    }
    this.limits = Object.freeze({
      globalConcurrency: asPositiveInteger(globalConcurrency, DEFAULT_GIT_EXECUTION_LIMITS.globalConcurrency, 'globalConcurrency'),
      readsPerCommonContext: asPositiveInteger(
        readsPerCommonContext,
        DEFAULT_GIT_EXECUTION_LIMITS.readsPerCommonContext,
        'readsPerCommonContext',
      ),
      networkPerCommonContext: asPositiveInteger(
        networkPerCommonContext,
        DEFAULT_GIT_EXECUTION_LIMITS.networkPerCommonContext,
        'networkPerCommonContext',
      ),
      globalNetworkConcurrency: asPositiveInteger(
        globalNetworkConcurrency,
        DEFAULT_GIT_EXECUTION_LIMITS.globalNetworkConcurrency,
        'globalNetworkConcurrency',
      ),
      maxQueuePerContext: asPositiveInteger(
        maxQueuePerContext,
        DEFAULT_GIT_EXECUTION_LIMITS.maxQueuePerContext,
        'maxQueuePerContext',
      ),
      maxGlobalQueue: asPositiveInteger(maxGlobalQueue, DEFAULT_GIT_EXECUTION_LIMITS.maxGlobalQueue, 'maxGlobalQueue'),
      maxContexts: asPositiveInteger(maxContexts, DEFAULT_GIT_EXECUTION_LIMITS.maxContexts, 'maxContexts'),
      maxWorktrees: asPositiveInteger(maxWorktrees, DEFAULT_GIT_EXECUTION_LIMITS.maxWorktrees, 'maxWorktrees'),
      maxStatusInFlight: asPositiveInteger(
        maxStatusInFlight,
        DEFAULT_GIT_EXECUTION_LIMITS.maxStatusInFlight,
        'maxStatusInFlight',
      ),
      maxCloneQueue: asPositiveInteger(maxCloneQueue, DEFAULT_GIT_EXECUTION_LIMITS.maxCloneQueue, 'maxCloneQueue'),
      maxCloneQueuePerDestination: asPositiveInteger(
        maxCloneQueuePerDestination,
        DEFAULT_GIT_EXECUTION_LIMITS.maxCloneQueuePerDestination,
        'maxCloneQueuePerDestination',
      ),
      maxCloneDestinations: asPositiveInteger(
        maxCloneDestinations,
        DEFAULT_GIT_EXECUTION_LIMITS.maxCloneDestinations,
        'maxCloneDestinations',
      ),
      idleTtlMs: asNonNegativeInteger(idleTtlMs, DEFAULT_GIT_EXECUTION_LIMITS.idleTtlMs, 'idleTtlMs'),
      idlePruneIntervalMs: asNonNegativeInteger(
        idlePruneIntervalMs,
        DEFAULT_GIT_EXECUTION_LIMITS.idlePruneIntervalMs,
        'idlePruneIntervalMs',
      ),
    });
    this.now = now;
    this.canonicalizeCloneDestination = canonicalizeCloneDestination;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.contexts = new Map();
    this.statusInFlight = new Map();
    this.clonePending = [];
    this.cloneDestinations = new Map();
    this.activeLeases = new WeakSet();
    this.globalActive = 0;
    this.globalPending = 0;
    this.globalNetworkActive = 0;
    this.totalWorktrees = 0;
    this.contextCursor = 0;
    this.draining = false;
    this.nextIdlePruneAt = 0;
  }

  pruneIdle({ force = false } = {}) {
    const now = this.now();
    for (const state of [...this.contexts.values()]) {
      if (state.activeCount > 0 || state.pending.length > 0 || this.hasStatusForContext(state.commonId)) {
        continue;
      }
      if (force || now - state.idleSince >= this.limits.idleTtlMs) {
        this.deleteContextState(state);
      }
    }
  }

  maybePruneIdle() {
    const now = this.now();
    if (now < this.nextIdlePruneAt) {
      return;
    }
    this.nextIdlePruneAt = now + this.limits.idlePruneIntervalMs;
    this.pruneIdle();
  }

  hasStatusForContext(commonId) {
    for (const entry of this.statusInFlight.values()) {
      if (entry.commonId === commonId) {
        return true;
      }
    }
    return false;
  }

  hasStatusForWorktree(commonId, worktreeId) {
    for (const entry of this.statusInFlight.values()) {
      if (entry.commonId === commonId && entry.worktreeId === worktreeId) {
        return true;
      }
    }
    return false;
  }

  deleteContextState(state) {
    if (this.contexts.get(state.commonId) !== state) {
      return;
    }
    this.contexts.delete(state.commonId);
    this.totalWorktrees -= state.worktrees.size;
    if (this.totalWorktrees < 0) {
      this.totalWorktrees = 0;
    }
  }

  deleteWorktreeState(state, worktree) {
    if (state.worktrees.get(worktree.worktreeId) !== worktree) {
      return false;
    }
    if (!state.worktrees.delete(worktree.worktreeId)) {
      return false;
    }
    this.totalWorktrees = Math.max(0, this.totalWorktrees - 1);
    return true;
  }

  evictOldestIdleContext() {
    let candidate = null;
    for (const state of this.contexts.values()) {
      if (state.activeCount > 0 || state.pending.length > 0 || this.hasStatusForContext(state.commonId)) {
        continue;
      }
      if (!candidate || state.lastUsedAt < candidate.lastUsedAt) {
        candidate = state;
      }
    }
    if (candidate) {
      this.deleteContextState(candidate);
      return true;
    }
    return false;
  }

  evictOldestIdleWorktree() {
    let candidate = null;
    let candidateContext = null;
    for (const state of this.contexts.values()) {
      for (const worktree of state.worktrees.values()) {
        if (
          worktree.activeCount > 0
          || worktree.pendingCount > 0
          || this.hasStatusForWorktree(state.commonId, worktree.worktreeId)
        ) {
          continue;
        }
        if (!candidate || worktree.lastUsedAt < candidate.lastUsedAt) {
          candidate = worktree;
          candidateContext = state;
        }
      }
    }
    if (!candidate || !candidateContext) {
      return false;
    }
    return this.deleteWorktreeState(candidateContext, candidate);
  }

  ensureContext(commonId) {
    const existing = this.contexts.get(commonId);
    if (existing) {
      existing.lastUsedAt = this.now();
      return existing;
    }

    while (this.contexts.size >= this.limits.maxContexts && this.evictOldestIdleContext()) {
      // Evict only inactive state retained for bounded generation history.
    }
    if (this.contexts.size >= this.limits.maxContexts) {
      throw new GitExecutionOverloadedError('Too many Git common contexts are active', {
        limit: this.limits.maxContexts,
        scope: 'common-contexts',
      });
    }

    const now = this.now();
    const state = createContextState(commonId, now);
    this.contexts.set(commonId, state);
    return state;
  }

  ensureWorktree(state, worktreeId) {
    if (!worktreeId) {
      throw new TypeError('A worktree identity is required for local Git execution');
    }
    const existing = state.worktrees.get(worktreeId);
    if (existing) {
      existing.lastUsedAt = this.now();
      return existing;
    }

    while (this.totalWorktrees >= this.limits.maxWorktrees && this.evictOldestIdleWorktree()) {
      // Evict only inactive generation history.
    }
    if (this.totalWorktrees >= this.limits.maxWorktrees) {
      throw new GitExecutionOverloadedError('Too many Git worktree contexts are active', {
        limit: this.limits.maxWorktrees,
        scope: 'worktree-contexts',
      });
    }

    const worktree = createWorktreeState(worktreeId, this.now());
    state.worktrees.set(worktreeId, worktree);
    this.totalWorktrees += 1;
    return worktree;
  }

  cleanupAdmissionFailure(state, worktree) {
    if (
      worktree
      && worktree.activeCount === 0
      && worktree.pendingCount === 0
      && worktree.generation === 0
      && !this.hasStatusForWorktree(state.commonId, worktree.worktreeId)
    ) {
      this.deleteWorktreeState(state, worktree);
    }
    if (
      state.activeCount === 0
      && state.pending.length === 0
      && !this.hasStatusForContext(state.commonId)
    ) {
      this.deleteContextState(state);
    }
  }

  getGeneration(context) {
    const state = this.contexts.get(context.commonId);
    const worktree = state?.worktrees.get(context.worktreeId);
    return {
      common: state?.commonGeneration || 0,
      worktree: worktree?.generation || 0,
    };
  }

  bumpGeneration(state, worktree, kind) {
    if (kind === GIT_OPERATION_KIND.COMMON_WRITE || kind === GIT_OPERATION_KIND.TOPOLOGY_WRITE) {
      state.commonGeneration += 1;
      return;
    }
    if (operationIsMutation(kind) && worktree) {
      worktree.generation += 1;
    }
  }

  invalidateWorktrees(commonId, worktreeIds) {
    const state = this.contexts.get(commonId);
    if (!state) {
      return 0;
    }
    const targets = new Set(Array.isArray(worktreeIds) ? worktreeIds.filter(Boolean) : []);
    let removed = 0;
    for (const worktreeId of targets) {
      const worktree = state.worktrees.get(worktreeId);
      if (
        !worktree
        || worktree.activeCount > 0
        || worktree.pendingCount > 0
        || this.hasStatusForWorktree(commonId, worktreeId)
      ) {
        continue;
      }
      if (this.deleteWorktreeState(state, worktree)) {
        removed += 1;
      }
    }
    return removed;
  }

  leaseCovers(lease, context, kind, { targetWorktree = false, network = false } = {}) {
    if (!lease || !this.activeLeases.has(lease) || !lease.active) {
      return false;
    }
    if (lease.commonId !== context.commonId) {
      return false;
    }
    if (network && !lease.network) {
      return false;
    }
    if (lease.kind === GIT_OPERATION_KIND.TOPOLOGY_WRITE) {
      return true;
    }
    if (kind === GIT_OPERATION_KIND.TOPOLOGY_WRITE) {
      return false;
    }
    if (kind === GIT_OPERATION_KIND.COMMON_WRITE) {
      if (lease.kind !== GIT_OPERATION_KIND.COMMON_WRITE) {
        return false;
      }
      return !targetWorktree || (
        lease.targetWorktree
        && lease.worktreeId === context.worktreeId
      );
    }
    if (lease.worktreeId !== context.worktreeId) {
      return false;
    }
    if (lease.kind === GIT_OPERATION_KIND.COMMON_WRITE) {
      return lease.targetWorktree;
    }
    if (lease.kind === GIT_OPERATION_KIND.WORKTREE_WRITE) {
      return true;
    }
    return lease.kind === GIT_OPERATION_KIND.READ && kind === GIT_OPERATION_KIND.READ;
  }

  run({
    context,
    kind,
    targetWorktree = false,
    network = false,
    label = 'Git operation',
    signal,
    queueTimeoutMs,
    lease,
  } = {}, task) {
    let normalizedQueueTimeoutMs;
    try {
      validateKind(kind);
      if (typeof targetWorktree !== 'boolean' || typeof network !== 'boolean') {
        throw new TypeError('targetWorktree and network must be booleans');
      }
      if (targetWorktree && kind !== GIT_OPERATION_KIND.COMMON_WRITE) {
        throw new TypeError('targetWorktree applies only to common Git mutations');
      }
      validateContext(context, kind, targetWorktree);
      normalizedQueueTimeoutMs = asOptionalPositiveInteger(queueTimeoutMs, 'queueTimeoutMs');
      if (typeof task !== 'function') {
        throw new TypeError('Git operation task must be a function');
      }
    } catch (error) {
      return Promise.reject(error);
    }

    if (lease) {
      if (!this.leaseCovers(lease, context, kind, { targetWorktree, network })) {
        return Promise.reject(new GitExecutionReentrancyError(undefined, {
          requestedKind: kind,
          activeKind: lease.kind,
          requestedTargetWorktree: targetWorktree,
          activeTargetWorktree: lease.targetWorktree,
          requestedNetwork: network,
          activeNetwork: lease.network,
        }));
      }
      return Promise.resolve().then(() => task(lease));
    }

    if (signal?.aborted) {
      return Promise.reject(new GitExecutionCancelledError(`${label} was cancelled before admission`));
    }

    let state;
    let worktree;
    try {
      this.maybePruneIdle();
      state = this.ensureContext(context.commonId);
      worktree = operationClaimsWorktree(kind, targetWorktree)
        ? this.ensureWorktree(state, context.worktreeId)
        : null;
      if (state.pending.length >= this.limits.maxQueuePerContext) {
        throw new GitExecutionOverloadedError('Git execution queue for this repository is full', {
          limit: this.limits.maxQueuePerContext,
          scope: 'context-queue',
        });
      }
      if (this.globalPending >= this.limits.maxGlobalQueue) {
        throw new GitExecutionOverloadedError('Global Git execution queue is full', {
          limit: this.limits.maxGlobalQueue,
          scope: 'global-queue',
        });
      }
    } catch (error) {
      if (state) {
        this.cleanupAdmissionFailure(state, worktree);
      }
      return Promise.reject(error);
    }

    let resolveOperation;
    let rejectOperation;
    const promise = new Promise((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    const operation = {
      context,
      state,
      worktree,
      kind,
      targetWorktree,
      network,
      label,
      signal,
      task,
      resolve: resolveOperation,
      reject: rejectOperation,
      abortHandler: null,
      timeoutHandle: null,
      started: false,
      finished: false,
    };

    state.pending.push(operation);
    state.idleSince = null;
    state.lastUsedAt = this.now();
    if (worktree) {
      worktree.pendingCount += 1;
      worktree.lastUsedAt = this.now();
    }
    this.globalPending += 1;
    this.bumpGeneration(state, worktree, kind);

    if (signal) {
      operation.abortHandler = () => this.cancelQueuedOperation(operation);
      signal.addEventListener('abort', operation.abortHandler, { once: true });
      if (signal.aborted) {
        this.cancelQueuedOperation(operation);
        return promise;
      }
    }

    if (normalizedQueueTimeoutMs !== null) {
      operation.timeoutHandle = this.setTimer(
        () => this.timeoutQueuedOperation(operation, normalizedQueueTimeoutMs),
        normalizedQueueTimeoutMs,
      );
    }

    this.drain();
    return promise;
  }

  cancelQueuedOperation(operation) {
    this.removeQueuedOperation(
      operation,
      new GitExecutionCancelledError(`${operation.label} was cancelled while queued`),
    );
  }

  timeoutQueuedOperation(operation, queueTimeoutMs) {
    this.removeQueuedOperation(
      operation,
      new GitExecutionQueueTimeoutError(`${operation.label} timed out while queued`, {
        queueTimeoutMs,
        scope: 'execution-queue',
      }),
    );
  }

  removeQueuedOperation(operation, error) {
    if (operation.started || operation.finished) {
      return;
    }
    const index = operation.state.pending.indexOf(operation);
    if (index < 0) {
      return;
    }

    operation.state.pending.splice(index, 1);
    this.globalPending -= 1;
    if (operation.worktree) {
      operation.worktree.pendingCount -= 1;
      operation.worktree.lastUsedAt = this.now();
    }
    if (operation.signal && operation.abortHandler) {
      operation.signal.removeEventListener('abort', operation.abortHandler);
    }
    if (operation.timeoutHandle !== null) {
      this.clearTimer(operation.timeoutHandle);
      operation.timeoutHandle = null;
    }
    operation.finished = true;
    this.bumpGeneration(operation.state, operation.worktree, operation.kind);
    operation.reject(error);
    this.markIdleIfDrained(operation.state);
    this.drain();
  }

  operationsConflict(first, second) {
    if (
      first.kind === GIT_OPERATION_KIND.TOPOLOGY_WRITE
      || second.kind === GIT_OPERATION_KIND.TOPOLOGY_WRITE
    ) {
      return true;
    }
    if (first.network && second.network) {
      return true;
    }
    if (
      first.kind === GIT_OPERATION_KIND.COMMON_WRITE
      && second.kind === GIT_OPERATION_KIND.COMMON_WRITE
    ) {
      return true;
    }
    if (!first.worktree || !second.worktree || first.worktree.worktreeId !== second.worktree.worktreeId) {
      return false;
    }
    return first.kind !== GIT_OPERATION_KIND.READ || second.kind !== GIT_OPERATION_KIND.READ;
  }

  canRun(operation) {
    const { state, kind, worktree } = operation;
    if (state.activeTopologyWrite) {
      return false;
    }
    if (
      operation.network
      && (
        state.activeNetwork >= this.limits.networkPerCommonContext
        || this.globalNetworkActive >= this.limits.globalNetworkConcurrency
      )
    ) {
      return false;
    }
    if (kind === GIT_OPERATION_KIND.TOPOLOGY_WRITE) {
      return state.activeCount === 0;
    }
    if (kind === GIT_OPERATION_KIND.COMMON_WRITE) {
      if (state.activeCommonWrite) {
        return false;
      }
      if (!worktree) {
        return true;
      }
      return (
        !state.activeWorktreeWrites.has(worktree.worktreeId)
        && (state.activeReadsByWorktree.get(worktree.worktreeId) || 0) === 0
      );
    }
    if (kind === GIT_OPERATION_KIND.READ) {
      return (
        state.activeReads < this.limits.readsPerCommonContext
        && !state.activeWorktreeWrites.has(worktree.worktreeId)
      );
    }
    return (
      !state.activeWorktreeWrites.has(worktree.worktreeId)
      && (state.activeReadsByWorktree.get(worktree.worktreeId) || 0) === 0
    );
  }

  findRunnableIndex(state) {
    for (let index = 0; index < state.pending.length; index += 1) {
      const operation = state.pending[index];
      if (!this.canRun(operation)) {
        continue;
      }
      let blockedByEarlierConflict = false;
      for (let earlierIndex = 0; earlierIndex < index; earlierIndex += 1) {
        if (this.operationsConflict(state.pending[earlierIndex], operation)) {
          blockedByEarlierConflict = true;
          break;
        }
      }
      if (!blockedByEarlierConflict) {
        return index;
      }
    }
    return -1;
  }

  drain() {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      this.maybePruneIdle();
      let madeProgress = true;
      while (this.globalActive < this.limits.globalConcurrency && madeProgress) {
        madeProgress = false;
        const sources = [...this.contexts.values()]
          .filter((state) => state.pending.length > 0)
          .map((state) => ({ kind: 'context', state }));
        if (this.clonePending.length > 0) {
          sources.push({ kind: 'clone' });
        }
        if (sources.length === 0) {
          break;
        }

        for (let offset = 0; offset < sources.length; offset += 1) {
          const index = (this.contextCursor + offset) % sources.length;
          const source = sources[index];
          const operationIndex = source.kind === 'clone'
            ? this.findRunnableCloneIndex()
            : this.findRunnableIndex(source.state);
          if (operationIndex < 0) {
            continue;
          }
          this.contextCursor = (index + 1) % sources.length;
          if (source.kind === 'clone') {
            const [operation] = this.clonePending.splice(operationIndex, 1);
            this.startCloneOperation(operation);
          } else {
            const [operation] = source.state.pending.splice(operationIndex, 1);
            this.startOperation(operation);
          }
          madeProgress = true;
          break;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  startOperation(operation) {
    operation.started = true;
    this.globalPending -= 1;
    this.globalActive += 1;
    operation.state.activeCount += 1;
    operation.state.lastUsedAt = this.now();
    if (operation.worktree) {
      operation.worktree.pendingCount -= 1;
      operation.worktree.activeCount += 1;
      operation.worktree.lastUsedAt = this.now();
    }
    if (operation.signal && operation.abortHandler) {
      operation.signal.removeEventListener('abort', operation.abortHandler);
    }
    if (operation.timeoutHandle !== null) {
      this.clearTimer(operation.timeoutHandle);
      operation.timeoutHandle = null;
    }

    if (operation.network) {
      operation.state.activeNetwork += 1;
      this.globalNetworkActive += 1;
    }
    if (operation.kind === GIT_OPERATION_KIND.TOPOLOGY_WRITE) {
      operation.state.activeTopologyWrite = true;
    } else if (operation.kind === GIT_OPERATION_KIND.COMMON_WRITE) {
      operation.state.activeCommonWrite = true;
      if (operation.worktree) {
        operation.state.activeWorktreeWrites.add(operation.worktree.worktreeId);
      }
    } else if (operation.kind === GIT_OPERATION_KIND.READ && operation.worktree) {
      operation.state.activeReads += 1;
      const current = operation.state.activeReadsByWorktree.get(operation.worktree.worktreeId) || 0;
      operation.state.activeReadsByWorktree.set(operation.worktree.worktreeId, current + 1);
    } else if (operation.worktree) {
      operation.state.activeWorktreeWrites.add(operation.worktree.worktreeId);
    }

    const lease = {
      commonId: operation.context.commonId,
      worktreeId: operation.context.worktreeId,
      kind: operation.kind,
      targetWorktree: operation.targetWorktree,
      network: operation.network,
      active: true,
    };
    this.activeLeases.add(lease);

    Promise.resolve()
      .then(() => operation.task(lease))
      .then(
        (value) => this.finishOperation(operation, lease, NO_EXECUTION_ERROR, value),
        (error) => this.finishOperation(operation, lease, error),
      );
  }

  finishOperation(operation, lease, error, value = undefined) {
    if (operation.finished) {
      return;
    }
    operation.finished = true;
    lease.active = false;
    this.activeLeases.delete(lease);
    this.globalActive -= 1;
    operation.state.activeCount -= 1;
    if (operation.worktree) {
      operation.worktree.activeCount -= 1;
      operation.worktree.lastUsedAt = this.now();
    }

    if (operation.network) {
      operation.state.activeNetwork -= 1;
      this.globalNetworkActive -= 1;
    }
    if (operation.kind === GIT_OPERATION_KIND.TOPOLOGY_WRITE) {
      operation.state.activeTopologyWrite = false;
    } else if (operation.kind === GIT_OPERATION_KIND.COMMON_WRITE) {
      operation.state.activeCommonWrite = false;
      if (operation.worktree) {
        operation.state.activeWorktreeWrites.delete(operation.worktree.worktreeId);
      }
    } else if (operation.kind === GIT_OPERATION_KIND.READ && operation.worktree) {
      operation.state.activeReads -= 1;
      const current = operation.state.activeReadsByWorktree.get(operation.worktree.worktreeId) || 0;
      if (current <= 1) {
        operation.state.activeReadsByWorktree.delete(operation.worktree.worktreeId);
      } else {
        operation.state.activeReadsByWorktree.set(operation.worktree.worktreeId, current - 1);
      }
    } else if (operation.worktree) {
      operation.state.activeWorktreeWrites.delete(operation.worktree.worktreeId);
    }

    this.bumpGeneration(operation.state, operation.worktree, operation.kind);
    if (error !== NO_EXECUTION_ERROR) {
      operation.reject(error);
    } else {
      operation.resolve(value);
    }
    this.markIdleIfDrained(operation.state);
    this.drain();
  }

  async runClone({
    destination,
    label = 'Git clone',
    signal,
    queueTimeoutMs,
  } = {}, task) {
    if (typeof task !== 'function') {
      throw new TypeError('Git clone task must be a function');
    }
    const normalizedQueueTimeoutMs = asOptionalPositiveInteger(queueTimeoutMs, 'queueTimeoutMs');
    if (signal?.aborted) {
      throw new GitExecutionCancelledError(`${label} was cancelled before admission`);
    }

    const destinationId = await this.canonicalizeCloneDestination(destination);
    if (typeof destinationId !== 'string' || !destinationId) {
      throw new TypeError('Clone destination canonicalization returned an invalid identity');
    }
    if (signal?.aborted) {
      throw new GitExecutionCancelledError(`${label} was cancelled before admission`);
    }

    this.maybePruneIdle();
    let destinationState = this.cloneDestinations.get(destinationId);
    let createdDestinationState = false;
    try {
      if (!destinationState) {
        if (this.cloneDestinations.size >= this.limits.maxCloneDestinations) {
          throw new GitExecutionOverloadedError('Too many Git clone destinations are active', {
            limit: this.limits.maxCloneDestinations,
            scope: 'clone-destinations',
          });
        }
        destinationState = createCloneDestinationState(destinationId, this.now());
        this.cloneDestinations.set(destinationId, destinationState);
        createdDestinationState = true;
      }
      if (this.clonePending.length >= this.limits.maxCloneQueue) {
        throw new GitExecutionOverloadedError('Git clone queue is full', {
          limit: this.limits.maxCloneQueue,
          scope: 'clone-queue',
        });
      }
      if (destinationState.pendingCount >= this.limits.maxCloneQueuePerDestination) {
        throw new GitExecutionOverloadedError('Git clone queue for this destination is full', {
          limit: this.limits.maxCloneQueuePerDestination,
          scope: 'clone-destination-queue',
        });
      }
      if (this.globalPending >= this.limits.maxGlobalQueue) {
        throw new GitExecutionOverloadedError('Global Git execution queue is full', {
          limit: this.limits.maxGlobalQueue,
          scope: 'global-queue',
        });
      }
    } catch (error) {
      if (createdDestinationState) {
        this.cloneDestinations.delete(destinationId);
      }
      throw error;
    }

    let resolveOperation;
    let rejectOperation;
    const promise = new Promise((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    const operation = {
      destinationId,
      destinationState,
      label,
      signal,
      task,
      resolve: resolveOperation,
      reject: rejectOperation,
      abortHandler: null,
      timeoutHandle: null,
      started: false,
      finished: false,
    };

    this.clonePending.push(operation);
    destinationState.pendingCount += 1;
    destinationState.lastUsedAt = this.now();
    this.globalPending += 1;

    if (signal) {
      operation.abortHandler = () => this.removeQueuedCloneOperation(
        operation,
        new GitExecutionCancelledError(`${label} was cancelled while queued`),
      );
      signal.addEventListener('abort', operation.abortHandler, { once: true });
      if (signal.aborted) {
        operation.abortHandler();
        return promise;
      }
    }
    if (normalizedQueueTimeoutMs !== null) {
      operation.timeoutHandle = this.setTimer(() => this.removeQueuedCloneOperation(
        operation,
        new GitExecutionQueueTimeoutError(`${label} timed out while queued`, {
          queueTimeoutMs: normalizedQueueTimeoutMs,
          scope: 'clone-queue',
        }),
      ), normalizedQueueTimeoutMs);
    }

    this.drain();
    return promise;
  }

  cleanupCloneDestination(destinationState) {
    if (destinationState.activeCount === 0 && destinationState.pendingCount === 0) {
      this.cloneDestinations.delete(destinationState.destinationId);
    }
  }

  removeQueuedCloneOperation(operation, error) {
    if (operation.started || operation.finished) {
      return;
    }
    const index = this.clonePending.indexOf(operation);
    if (index < 0) {
      return;
    }
    this.clonePending.splice(index, 1);
    this.globalPending -= 1;
    operation.destinationState.pendingCount -= 1;
    operation.destinationState.lastUsedAt = this.now();
    if (operation.signal && operation.abortHandler) {
      operation.signal.removeEventListener('abort', operation.abortHandler);
    }
    if (operation.timeoutHandle !== null) {
      this.clearTimer(operation.timeoutHandle);
      operation.timeoutHandle = null;
    }
    operation.finished = true;
    operation.reject(error);
    this.cleanupCloneDestination(operation.destinationState);
    this.drain();
  }

  findRunnableCloneIndex() {
    if (this.globalNetworkActive >= this.limits.globalNetworkConcurrency) {
      return -1;
    }
    for (let index = 0; index < this.clonePending.length; index += 1) {
      const operation = this.clonePending[index];
      if (operation.destinationState.activeCount > 0) {
        continue;
      }
      const earlierSameDestination = this.clonePending
        .slice(0, index)
        .some((earlier) => earlier.destinationId === operation.destinationId);
      if (!earlierSameDestination) {
        return index;
      }
    }
    return -1;
  }

  startCloneOperation(operation) {
    operation.started = true;
    this.globalPending -= 1;
    this.globalActive += 1;
    this.globalNetworkActive += 1;
    operation.destinationState.pendingCount -= 1;
    operation.destinationState.activeCount += 1;
    operation.destinationState.lastUsedAt = this.now();
    if (operation.signal && operation.abortHandler) {
      operation.signal.removeEventListener('abort', operation.abortHandler);
    }
    if (operation.timeoutHandle !== null) {
      this.clearTimer(operation.timeoutHandle);
      operation.timeoutHandle = null;
    }

    const lease = {
      kind: 'clone-reservation',
      destinationId: operation.destinationId,
      network: true,
      active: true,
    };
    lease.releaseNetwork = () => {
      if (!lease.active || !lease.network) {
        return;
      }
      lease.network = false;
      this.globalNetworkActive -= 1;
      this.drain();
    };
    this.activeLeases.add(lease);
    Promise.resolve()
      .then(() => operation.task(lease))
      .then(
        (value) => this.finishCloneOperation(operation, lease, NO_EXECUTION_ERROR, value),
        (error) => this.finishCloneOperation(operation, lease, error),
      );
  }

  finishCloneOperation(operation, lease, error, value = undefined) {
    if (operation.finished) {
      return;
    }
    operation.finished = true;
    lease.active = false;
    this.activeLeases.delete(lease);
    this.globalActive -= 1;
    if (lease.network) {
      this.globalNetworkActive -= 1;
    }
    operation.destinationState.activeCount -= 1;
    operation.destinationState.lastUsedAt = this.now();
    if (error !== NO_EXECUTION_ERROR) {
      operation.reject(error);
    } else {
      operation.resolve(value);
    }
    this.cleanupCloneDestination(operation.destinationState);
    this.drain();
  }

  markIdleIfDrained(state) {
    state.lastUsedAt = this.now();
    if (state.activeCount === 0 && state.pending.length === 0) {
      state.idleSince = this.now();
    }
  }

  statusKey(context, shape, generation) {
    return JSON.stringify([
      context.commonId,
      context.worktreeId,
      shape,
      generation.common,
      generation.worktree,
    ]);
  }

  runStatus({
    context,
    shape = 'full',
    signal,
    queueTimeoutMs,
    projectResult = (value) => value,
    label = 'Git status',
  } = {}, task) {
    if (shape !== 'full' && shape !== 'light') {
      return Promise.reject(new TypeError('Git status shape must be full or light'));
    }
    if (signal?.aborted) {
      return Promise.reject(new GitExecutionCancelledError(`${label} was cancelled before admission`));
    }

    try {
      validateContext(context, GIT_OPERATION_KIND.READ);
    } catch (error) {
      return Promise.reject(error);
    }

    this.maybePruneIdle();
    const generation = this.getGeneration(context);
    const requestedKey = this.statusKey(context, shape, generation);
    const fullKey = shape === 'light' ? this.statusKey(context, 'full', generation) : requestedKey;
    const existing = this.statusInFlight.get(fullKey) || this.statusInFlight.get(requestedKey);
    if (existing) {
      const projected = existing.promise.then((value) => projectResult(value, shape, existing.shape));
      return waitForSharedPromise(projected, signal, label);
    }

    if (this.statusInFlight.size >= this.limits.maxStatusInFlight) {
      return Promise.reject(new GitExecutionOverloadedError('Too many Git status operations are in flight', {
        limit: this.limits.maxStatusInFlight,
        scope: 'status-in-flight',
      }));
    }

    const shared = this.run({
      context,
      kind: GIT_OPERATION_KIND.READ,
      label,
      queueTimeoutMs,
    }, () => task(shape));
    const entry = {
      commonId: context.commonId,
      worktreeId: context.worktreeId,
      shape,
      generation,
      promise: shared,
    };
    this.statusInFlight.set(requestedKey, entry);
    const clear = () => {
      if (this.statusInFlight.get(requestedKey) === entry) {
        this.statusInFlight.delete(requestedKey);
      }
    };
    shared.then(clear, clear);
    // A waiter may cancel before shared work settles. Keep the shared rejection observed.
    shared.catch(() => {});

    const projected = shared.then((value) => projectResult(value, shape, shape));
    return waitForSharedPromise(projected, signal, label);
  }

  getStats() {
    let idleContexts = 0;
    for (const state of this.contexts.values()) {
      if (state.activeCount === 0 && state.pending.length === 0) {
        idleContexts += 1;
      }
    }
    return {
      active: this.globalActive,
      pending: this.globalPending,
      activeNetwork: this.globalNetworkActive,
      contexts: this.contexts.size,
      idleContexts,
      worktrees: this.totalWorktrees,
      statusInFlight: this.statusInFlight.size,
      clonePending: this.clonePending.length,
      cloneDestinations: this.cloneDestinations.size,
      limits: this.limits,
    };
  }
}

export const createGitExecutionCoordinator = (options) => new GitExecutionCoordinator(options);
