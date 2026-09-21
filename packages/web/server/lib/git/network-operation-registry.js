const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_TERMINAL_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_PLANNED_RETENTION_MS = 15 * 60 * 1000;
const TERMINAL_STATES = new Set([
  'succeeded', 'partial', 'conflicted', 'failed', 'cancelled', 'outcome-unknown',
]);
const OPERATION_STEPS = new Set([
  'validated', 'authenticated', 'transferred', 'updated-local-repository', 'checked-out', 'cleaned-up',
]);
const ERROR_CODES = new Set([
  'INVALID_REQUEST', 'NOT_FOUND', 'STALE_REPOSITORY', 'STALE_BINDING', 'STALE_CONFIG',
  'REMOTE_CHANGED', 'AUTHENTICATION_REQUIRED', 'AUTHENTICATION_FAILED', 'TRANSPORT_FAILED',
  'CONFLICT', 'CANCELLED', 'TIMEOUT', 'OUTCOME_UNKNOWN', 'RUNTIME_UNSUPPORTED', 'UNKNOWN',
  'GIT_LFS_CLIENT_MISSING',
]);
const FAILURE_ERROR_CODES = new Set([
  'INVALID_REQUEST', 'AUTHENTICATION_REQUIRED', 'AUTHENTICATION_FAILED', 'TRANSPORT_FAILED',
  'RUNTIME_UNSUPPORTED', 'GIT_LFS_CLIENT_MISSING', 'UNKNOWN',
]);
const STATE_ERROR_CODES = Object.freeze({
  partial: FAILURE_ERROR_CODES,
  conflicted: new Set(['STALE_REPOSITORY', 'STALE_BINDING', 'STALE_CONFIG', 'REMOTE_CHANGED', 'CONFLICT']),
  failed: FAILURE_ERROR_CODES,
  cancelled: new Set(['CANCELLED', 'TIMEOUT']),
  'outcome-unknown': new Set(['OUTCOME_UNKNOWN']),
});
const SYNC_STEP_STATUSES = new Set(['succeeded', 'skipped', 'conflicted', 'failed', 'cancelled']);
const isValidSyncStepResults = (value) => Array.isArray(value)
  && value.length === 3
  && value.every((result, index) => isPlainObject(result)
    && hasExactKeys(result, ['step', 'status'], ['error'])
    && result.step === ['fetch', 'pull', 'push'][index]
    && SYNC_STEP_STATUSES.has(result.status)
    && ((['succeeded', 'skipped'].includes(result.status) && result.error === undefined)
      || (!['succeeded', 'skipped'].includes(result.status) && isPlainObject(result.error)
      && hasExactKeys(result.error, ['code', 'message'])
      && ERROR_CODES.has(result.error.code)
      && isString(result.error.message)
      && Boolean(result.error.message))));
const HYDRATION_STATUSES = new Set([
  'succeeded', 'authorization-required', 'invalid', 'client-missing', 'failed', 'cancelled', 'not-needed',
]);
const isPublicError = (value) => isPlainObject(value)
  && hasExactKeys(value, ['code', 'message'])
  && ERROR_CODES.has(value.code)
  && isBoundedString(value.message, 4096);
const isHydrationPart = (value, pathRequired) => isPlainObject(value)
  && hasExactKeys(value, pathRequired ? ['path', 'status'] : ['status'], ['endpoint', 'error'])
  && (!pathRequired || isRelativeCheckoutPath(value.path))
  && HYDRATION_STATUSES.has(value.status)
  && (value.endpoint === undefined || (isPlainObject(value.endpoint)
    && hasExactKeys(value.endpoint, ['displayUrl', 'fingerprint'])
    && isSafeDisplayEndpoint(value.endpoint.displayUrl)
    && isBoundedString(value.endpoint.fingerprint, 512)))
  && (value.error === undefined || isPublicError(value.error))
  && (['succeeded', 'not-needed'].includes(value.status)
    ? value.error === undefined
    : value.error !== undefined);
const expectedHydrationStatus = (parts) => {
  const statuses = parts.map((entry) => entry.status);
  if (!statuses.length || statuses.every((status) => status === 'not-needed')) return 'not-needed';
  for (const status of ['cancelled', 'invalid', 'client-missing', 'authorization-required', 'failed']) {
    if (statuses.includes(status)) return status;
  }
  return 'succeeded';
};
const isValidHydration = (value) => isPlainObject(value)
  && hasExactKeys(value, ['status', 'submodules', 'lfs'])
  && HYDRATION_STATUSES.has(value.status)
  && Array.isArray(value.submodules)
  && value.submodules.length <= 256
  && value.submodules.every((entry) => isHydrationPart(entry, true))
  && Array.isArray(value.lfs)
  && value.lfs.length <= 256
  && value.lfs.every((entry) => isHydrationPart(entry, true))
  && expectedHydrationStatus([...value.submodules, ...value.lfs]) === value.status;
const isPlainObject = (value) => value === Object(value)
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const isString = (value) => Object.prototype.toString.call(value) === '[object String]';
const isBoundedString = (value, max) => isString(value) && value.trim() === value
  && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
const isSafeDisplayEndpoint = (value) => {
  if (!isBoundedString(value, 4096)) return false;
  if (!value.includes('://')) {
    const match = value.match(/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:([^\s:\\]+)$/);
    return Boolean(match && !/[?#]/.test(value) && !match[1].startsWith('-')
      && match[1].split('/').every((part) => part && part !== '.' && part !== '..'));
  }
  try {
    const endpoint = new URL(value);
    const pathname = decodeURIComponent(endpoint.pathname);
    return ['https:', 'ssh:'].includes(endpoint.protocol)
      && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
      && Boolean(endpoint.hostname && endpoint.pathname && endpoint.pathname !== '/')
      && !/[\0-\x20\x7f\\]/.test(pathname)
      && pathname.split('/').slice(1).every((part) => part && part !== '.' && part !== '..');
  } catch {
    return false;
  }
};
const isRelativeCheckoutPath = (value) => isBoundedString(value, 4096)
  && !/[\0-\x1f\x7f]/.test(value)
  && value !== '..' && !value.startsWith('../') && !value.includes('/../')
  && !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value) && !value.includes('\\');
const hasExactKeys = (value, required, optional = []) => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};
const cloneAndFreeze = (value) => {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze));
  if (!isPlainObject(value)) return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneAndFreeze(child)]),
  ));
};
const parseTransportMetadata = (value) => {
  if (!isPlainObject(value)) return null;
  if (hasExactKeys(value, ['fingerprint']) && isString(value.fingerprint) && /^SHA256:[A-Za-z0-9+/]{43}=?$/.test(value.fingerprint)) {
    return { kind: 'ssh-key', fingerprint: value.fingerprint };
  }
  if (hasExactKeys(value, ['provider', 'instance', 'accountId', 'login'])
    && ['github', 'gitlab'].includes(value.provider)
    && isBoundedString(value.instance, 4096)
    && isBoundedString(value.accountId, 512)
    && (value.login === null || isBoundedString(value.login, 512))) {
    const actor = {
      kind: 'provider',
      provider: value.provider,
      instance: value.instance,
      accountId: value.accountId,
    };
    if (value.login) actor.login = value.login;
    return actor;
  }
  return null;
};

const registryError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};
const requireOperationId = (value) => {
  if (!isString(value) || !value) throw registryError('INVALID_GIT_NETWORK_OPERATION', 'operationId is required');
  return value;
};
const isValidCompletion = (completion) => {
  if (!isPlainObject(completion)
    || !hasExactKeys(completion, ['state'], ['error', 'stepResults', 'hydration'])
    || !TERMINAL_STATES.has(completion.state)) return false;
  if (completion.stepResults !== undefined && !isValidSyncStepResults(completion.stepResults)) return false;
  if (completion.hydration !== undefined && !isValidHydration(completion.hydration)) return false;
  if (completion.state === 'succeeded' && completion.hydration
    && !['succeeded', 'not-needed'].includes(completion.hydration.status)) return false;
  if (completion.state === 'succeeded') return completion.error === undefined;
  return isPlainObject(completion.error)
    && hasExactKeys(completion.error, ['code', 'message'])
    && ERROR_CODES.has(completion.error.code)
    && STATE_ERROR_CODES[completion.state]?.has(completion.error.code)
    && isString(completion.error.message)
    && Boolean(completion.error.message);
};

const normalizeCompletion = (result, cancellationRequested) => {
  if (isValidCompletion(result)) return result;
  if (cancellationRequested) {
    return {
      state: 'cancelled',
      error: { code: 'CANCELLED', message: 'Git network operation was cancelled' },
    };
  }
  if (result === undefined) return { state: 'succeeded' };
  return {
    state: 'failed',
    error: { code: 'UNKNOWN', message: 'Git network operation returned an invalid result' },
  };
};

export function createNetworkOperationRegistry({
  maxEntries = DEFAULT_MAX_ENTRIES,
  terminalRetentionMs = DEFAULT_TERMINAL_RETENTION_MS,
  plannedRetentionMs = DEFAULT_PLANNED_RETENTION_MS,
  now = Date.now,
  cancelChild = (child) => child.kill(),
  store,
} = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1
    || !Number.isFinite(terminalRetentionMs) || terminalRetentionMs < 0
    || !Number.isFinite(plannedRetentionMs) || plannedRetentionMs < 1
    || !(now instanceof Function) || !(cancelChild instanceof Function)
    || (store !== undefined && (!(store.claim instanceof Function)
      || !(store.update instanceof Function) || !(store.recover instanceof Function)
      || !(store.read instanceof Function)))) {
    throw new TypeError('Git network operation registry options are invalid');
  }
  const entries = new Map();
  const starts = new Map();

  const snapshot = (entry) => {
    const value = {
      ...entry.publicPlan,
      transport: entry.transport ?? entry.publicPlan.transport,
      state: entry.state,
      completedSteps: entry.completedSteps,
    };
    if (entry.completion) Object.assign(value, entry.completion);
    return cloneAndFreeze(value);
  };
  const cleanupLocal = () => {
    const cutoff = now() - terminalRetentionMs;
    const plannedCutoff = now() - plannedRetentionMs;
    let removed = 0;
    for (const [operationId, entry] of entries) {
      if ((TERMINAL_STATES.has(entry.state) && entry.state !== 'outcome-unknown' && entry.finishedAt <= cutoff)
        || (!store && entry.state === 'planned' && entry.createdAt <= plannedCutoff)) {
        entries.delete(operationId);
        starts.delete(operationId);
        removed += 1;
      }
    }
    return removed;
  };
  const evictOldestTerminal = () => {
    let candidate;
    for (const [operationId, entry] of entries) {
      if (!TERMINAL_STATES.has(entry.state) || entry.state === 'outcome-unknown') continue;
      if (!candidate || entry.finishedAt < candidate.entry.finishedAt) candidate = { operationId, entry };
    }
    if (!candidate) return false;
    entries.delete(candidate.operationId);
    starts.delete(candidate.operationId);
    return true;
  };
  const getEntry = (operationId) => {
    cleanupLocal();
    const entry = entries.get(requireOperationId(operationId));
    if (!entry) throw registryError('GIT_NETWORK_OPERATION_NOT_FOUND', 'Git network operation was not found');
    return entry;
  };
  const recoveredEntry = (value) => {
    const { state, completedSteps, error, stepResults, hydration, ...publicPlan } = value;
    const completion = {};
    if (error !== undefined) completion.error = cloneAndFreeze(error);
    if (stepResults !== undefined) completion.stepResults = cloneAndFreeze(stepResults);
    if (hydration !== undefined) completion.hydration = cloneAndFreeze(hydration);
    return {
      internalPlan: undefined,
      publicPlan: cloneAndFreeze(publicPlan),
      state,
      createdAt: now(),
      cancellationRequested: false,
      transferStarted: new Set(),
      integrationStarted: false,
      transportMetadata: undefined,
      transport: value.transport,
      completedSteps: [...completedSteps],
      finishedAt: now(),
      completion: cloneAndFreeze(completion),
      child: undefined,
      executionPromise: undefined,
      cancellationListeners: new Set(),
      recovered: true,
    };
  };
  let recovery = null;
  const ensureRecovered = () => {
    if (!store) return null;
    recovery ??= Promise.resolve(store.recover()).then((snapshots) => {
      for (const value of snapshots) {
        if (!entries.has(value.operationId)) entries.set(value.operationId, recoveredEntry(value));
      }
    });
    return recovery;
  };
  const syncRecoverySteps = (entry) => {
    if (entry.publicPlan.target?.operation !== 'sync') return undefined;
    const interrupted = (step) => ({
      step,
      status: 'cancelled',
      error: { code: 'OUTCOME_UNKNOWN', message: 'Durable Git operation state could not be recorded' },
    });
    if (entry.transferStarted.has('publication')) return [
      { step: 'fetch', status: 'succeeded' },
      { step: 'pull', status: 'succeeded' },
      interrupted('push'),
    ];
    if (entry.integrationStarted) return [
      { step: 'fetch', status: 'succeeded' },
      interrupted('pull'),
      { step: 'push', status: 'skipped' },
    ];
    return [interrupted('fetch'), { step: 'pull', status: 'skipped' }, { step: 'push', status: 'skipped' }];
  };
  const blockForDurability = (entry) => {
    entry.state = 'outcome-unknown';
    entry.finishedAt = now();
    entry.child = undefined;
    const completion = {
      error: {
        code: 'OUTCOME_UNKNOWN',
        message: 'Git operation state could not be saved; inspect repository and remote state before retrying',
      },
    };
    const stepResults = syncRecoverySteps(entry);
    if (stepResults) completion.stepResults = stepResults;
    entry.completion = cloneAndFreeze(completion);
    return snapshot(entry);
  };
  const persist = async (entry, value) => {
    if (!store) return value;
    return store.update(entry.publicPlan.operationId, {
      snapshot: value,
      remotePublicationStarted: entry.transferStarted.has('publication') || entry.transferStarted.has('push'),
      localIntegrationStarted: entry.integrationStarted,
    });
  };
  const persistDurabilityBlock = async (entry) => {
    const blocked = blockForDurability(entry);
    try { await persist(entry, blocked); } catch {}
    return blocked;
  };
  const finishLocal = (operationId, completion) => {
    if (!isValidCompletion(completion)) {
      throw registryError('INVALID_GIT_NETWORK_OPERATION_COMPLETION', 'Git network operation completion is invalid');
    }
    const entry = getEntry(operationId);
    if ((entry.publicPlan.target?.operation === 'sync') !== (completion.stepResults !== undefined)) {
      throw registryError('INVALID_GIT_NETWORK_OPERATION_COMPLETION', 'Git sync operation step results are invalid');
    }
    if (TERMINAL_STATES.has(entry.state)) {
      if (entry.state !== completion.state) {
        throw registryError('GIT_NETWORK_OPERATION_TERMINAL', 'Git network operation is already terminal');
      }
      return snapshot(entry);
    }
    if (entry.child) {
      try { cancelChild(entry.child); } catch {}
    }
    const completionData = {};
    if (completion.error !== undefined) completionData.error = cloneAndFreeze(completion.error);
    if (completion.stepResults !== undefined) completionData.stepResults = cloneAndFreeze(completion.stepResults);
    if (completion.hydration !== undefined) completionData.hydration = cloneAndFreeze(completion.hydration);
    return { entry, completionData: cloneAndFreeze(completionData) };
  };
  const finish = (operationId, completion) => {
    const prepared = finishLocal(operationId, completion);
    if (!prepared?.entry) return prepared;
    const { entry, completionData } = prepared;
    const commit = () => {
      entry.state = completion.state;
      entry.finishedAt = now();
      entry.child = undefined;
      entry.completion = completionData;
      return snapshot(entry);
    };
    if (!store) return commit();
    const candidate = cloneAndFreeze({
      ...snapshot(entry),
      state: completion.state,
      ...completionData,
    });
    return persist(entry, candidate).then(commit, () => persistDurabilityBlock(entry));
  };
  const validateStep = (entry, step) => {
    if (TERMINAL_STATES.has(entry.state)) {
      throw registryError('GIT_NETWORK_OPERATION_TERMINAL', 'Git network operation is already terminal');
    }
    if (!isString(step) || !OPERATION_STEPS.has(step)) {
      throw registryError('INVALID_GIT_NETWORK_OPERATION_STEP', 'Git network operation step is invalid');
    }
  };
  const markStepCompleted = (operationId, step) => {
    const entry = getEntry(operationId);
    validateStep(entry, step);
    if (entry.completedSteps.includes(step)) return store ? Promise.resolve(snapshot(entry)) : snapshot(entry);
    if (!store) {
      entry.completedSteps.push(step);
      return snapshot(entry);
    }
    const candidate = cloneAndFreeze({ ...snapshot(entry), completedSteps: [...entry.completedSteps, step] });
    return persist(entry, candidate).then(() => {
      entry.completedSteps.push(step);
      return snapshot(entry);
    }, async (error) => {
      entry.completedSteps.push(step);
      await persistDurabilityBlock(entry);
      throw registryError('GIT_NETWORK_OPERATION_DURABILITY_FAILED', 'Git operation progress could not be saved', { cause: error });
    });
  };
  const attachChild = (operationId, child, { allowAfterCancellation = false } = {}) => {
    const entry = getEntry(operationId);
    if (entry.state !== 'running' || !child || !(child.kill instanceof Function)) {
      throw registryError('INVALID_GIT_NETWORK_OPERATION_CHILD', 'Git network operation child is invalid');
    }
    if (entry.child && entry.child !== child) {
      throw registryError('GIT_NETWORK_OPERATION_CHILD_ATTACHED', 'Git network operation already has a child');
    }
    entry.child = child;
    if (entry.cancellationRequested && !allowAfterCancellation) {
      try { cancelChild(child); } catch {}
    }
    return entry.cancellationRequested;
  };
  const detachChild = (operationId, child) => {
    const entry = getEntry(operationId);
    if (entry.child === child) entry.child = undefined;
  };
  const cancelLocal = (operationId) => {
    const entry = getEntry(operationId);
    if (TERMINAL_STATES.has(entry.state)) return snapshot(entry);
    if (entry.cancellationRequested) return snapshot(entry);
    entry.cancellationRequested = true;
    for (const listener of entry.cancellationListeners) {
      try { listener(); } catch {}
    }
    entry.cancellationListeners.clear();
    if (entry.child) {
      try { cancelChild(entry.child); } catch {}
    }
    if (entry.state === 'planned') return finish(operationId, {
      state: 'cancelled',
      error: { code: 'CANCELLED', message: 'Git network operation was cancelled' },
    });
    return snapshot(entry);
  };
  const updateTransportMetadata = (operationId, metadata, role) => {
    const entry = getEntry(operationId);
    if (entry.state !== 'running') {
      throw registryError('GIT_NETWORK_OPERATION_TERMINAL', 'Git network operation is not authenticating');
    }
    const parsed = parseTransportMetadata(metadata);
    if (!parsed) throw registryError('INVALID_GIT_NETWORK_OPERATION', 'Git transport metadata is invalid');
    const metadataKey = role ?? 'operation';
    if (role !== undefined && !['fetch', 'push'].includes(role)) {
      throw registryError('INVALID_GIT_NETWORK_OPERATION', 'Git transport role is invalid');
    }
    const previous = entry.transportMetadata?.[metadataKey];
    if (previous && JSON.stringify(previous) !== JSON.stringify(parsed)) {
      throw registryError('INVALID_GIT_NETWORK_OPERATION', 'Git transport metadata is already set');
    }
    entry.transportMetadata = cloneAndFreeze({ ...(entry.transportMetadata ?? {}), [metadataKey]: parsed });
    if (role) {
      entry.transport = cloneAndFreeze({
        ...(entry.transport ?? entry.publicPlan.transport),
        [role]: { ...(entry.transport ?? entry.publicPlan.transport)[role], actor: parsed },
      });
    } else {
      entry.transport = cloneAndFreeze({ ...entry.publicPlan.transport, actor: parsed });
    }
  };

  const registerLocal = (plans) => {
    if (!isPlainObject(plans)
      || !hasExactKeys(plans, ['internalPlan', 'publicPlan'])
      || !isPlainObject(plans.internalPlan)
      || !isPlainObject(plans.publicPlan)) {
      throw registryError('INVALID_GIT_NETWORK_OPERATION', 'Git network operation plans are invalid');
    }
    const operationId = requireOperationId(plans.internalPlan.operationId);
    if (plans.publicPlan.operationId !== operationId) {
      throw registryError('INVALID_GIT_NETWORK_OPERATION', 'Git network operation plan IDs do not match');
    }
    cleanupLocal();
    if (entries.has(operationId)) {
      throw registryError('GIT_NETWORK_OPERATION_EXISTS', 'Git network operation already exists');
    }
    while (entries.size >= maxEntries && evictOldestTerminal()) {}
    if (entries.size >= maxEntries) {
      throw registryError('GIT_NETWORK_OPERATION_CAPACITY', 'Git network operation capacity reached');
    }
    const entry = {
      internalPlan: cloneAndFreeze(plans.internalPlan),
      publicPlan: cloneAndFreeze(plans.publicPlan),
      state: 'planned',
      createdAt: now(),
      cancellationRequested: false,
      transferStarted: new Set(),
      transportMetadata: undefined,
      transport: undefined,
      completedSteps: [],
      finishedAt: undefined,
      completion: undefined,
      child: undefined,
      executionPromise: undefined,
      cancellationListeners: new Set(),
    };
    entries.set(operationId, entry);
    return snapshot(entry);
  };
  const register = (plans) => {
    if (!store) return registerLocal(plans);
    return Promise.resolve(ensureRecovered()).then(async () => {
      const registered = registerLocal(plans);
      try {
        await store.claim(registered);
        return registered;
      } catch (error) {
        entries.delete(registered.operationId);
        throw error;
      }
    });
  };

  const runStart = async (operationId, execute) => {
    if (store) await ensureRecovered();
    const entry = getEntry(operationId);
    if (entry.state !== 'planned' || entry.recovered || !(execute instanceof Function)) {
      throw registryError('GIT_NETWORK_OPERATION_NOT_STARTABLE', 'Git network operation cannot start');
    }
    if (store) {
      const running = cloneAndFreeze({ ...snapshot(entry), state: 'running' });
      try { await persist(entry, running); }
      catch { return persistDurabilityBlock(entry); }
    }
    entry.state = 'running';
    const transferMarker = (role) => {
      if (role === 'push') return 'publication';
      if (role === 'operation'
        && ['push', 'delete-remote-branch'].includes(entry.internalPlan?.target?.operation)) return 'publication';
      return role;
    };
    const controls = Object.freeze({
      attachChild: (child, options) => attachChild(operationId, child, options),
      detachChild: (child) => detachChild(operationId, child),
      isCancellationRequested: () => entry.cancellationRequested,
      markTransferStarted: (role = 'operation') => {
        const marker = transferMarker(role);
        if (entry.transferStarted.has(marker)) return store ? Promise.resolve() : undefined;
        if (!store) {
          entry.transferStarted.add(marker);
          return undefined;
        }
        entry.transferStarted.add(marker);
        return persist(entry, snapshot(entry)).catch(async (error) => {
          await persistDurabilityBlock(entry);
          throw registryError('GIT_NETWORK_OPERATION_DURABILITY_FAILED', 'Git transfer state could not be saved', { cause: error });
        });
      },
      hasTransferStarted: (role = 'operation') => entry.transferStarted.has(transferMarker(role)),
      markIntegrationStarted: () => {
        if (entry.integrationStarted) return store ? Promise.resolve() : undefined;
        entry.integrationStarted = true;
        if (!store) return undefined;
        return persist(entry, snapshot(entry)).catch(async (error) => {
          await persistDurabilityBlock(entry);
          throw registryError('GIT_NETWORK_OPERATION_DURABILITY_FAILED', 'Git integration state could not be saved', { cause: error });
        });
      },
      onCancellationRequested: (listener) => {
        if (!(listener instanceof Function)) {
          throw registryError('INVALID_GIT_NETWORK_OPERATION', 'Cancellation listener is invalid');
        }
        if (entry.cancellationRequested) listener();
        else entry.cancellationListeners.add(listener);
        return () => entry.cancellationListeners.delete(listener);
      },
      updateTransportMetadata: (metadata, role) => updateTransportMetadata(operationId, metadata, role),
      markStepCompleted: (step) => markStepCompleted(operationId, step),
      finish: (completion) => finish(operationId, completion),
    });
    return Promise.resolve()
      .then(() => execute(entry.internalPlan, controls))
      .then(async (result) => {
        if (!TERMINAL_STATES.has(entry.state)) {
          await finish(operationId, normalizeCompletion(result, entry.cancellationRequested));
        }
        return snapshot(entry);
      }, async (error) => {
        if (!TERMINAL_STATES.has(entry.state)) {
          const pushMayHaveStarted = entry.transferStarted.has('publication');
          let state = 'failed';
          let code = 'UNKNOWN';
          let message = 'Git network operation failed';
          if (pushMayHaveStarted) {
            state = 'outcome-unknown';
            code = 'OUTCOME_UNKNOWN';
            message = 'Push was interrupted after it started; the remote outcome is unknown';
          } else if (entry.cancellationRequested) {
            state = 'cancelled';
            code = 'CANCELLED';
            message = 'Git network operation was cancelled';
          }
          const completion = {
            state,
            error: { code, message },
          };
          if (entry.internalPlan?.target?.operation === 'sync') {
            completion.stepResults = syncRecoverySteps(entry);
          }
          await finish(operationId, completion);
        }
        return snapshot(entry);
      });
  };
  const start = (operationId, execute) => {
    requireOperationId(operationId);
    if (starts.has(operationId)) return starts.get(operationId);
    const operation = runStart(operationId, execute);
    starts.set(operationId, operation);
    operation.finally(() => {
      const entry = entries.get(operationId);
      if (entry) entry.executionPromise = operation;
    }).catch(() => {});
    return operation;
  };

  const cancel = (operationId) => store
    ? Promise.resolve(ensureRecovered()).then(() => cancelLocal(operationId))
    : cancelLocal(operationId);
  const get = (operationId) => {
    if (!store) return snapshot(getEntry(operationId));
    return Promise.resolve(ensureRecovered()).then(async () => {
      cleanupLocal();
      const local = entries.get(requireOperationId(operationId));
      if (local) return snapshot(local);
      const durable = await store.read(operationId);
      if (!durable) throw registryError('GIT_NETWORK_OPERATION_NOT_FOUND', 'Git network operation was not found');
      const entry = recoveredEntry(durable);
      entries.set(operationId, entry);
      return snapshot(entry);
    });
  };
  const cleanup = () => {
    const removed = cleanupLocal();
    return store ? Promise.resolve(ensureRecovered()).then(() => removed) : removed;
  };

  return {
    register,
    start,
    attachChild,
    cancel,
    markStepCompleted,
    updateTransportMetadata,
    finish,
    get,
    getInternalPlan(operationId) {
      return getEntry(operationId).internalPlan;
    },
    isCancellationRequested(operationId) {
      return getEntry(operationId).cancellationRequested;
    },
    cleanup,
  };
}
