import { createHash } from 'node:crypto';

const valueTag = (value) => Object.prototype.toString.call(value);
const isPlainObject = (value) => value === Object(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const canonicalJson = (value, ancestors = new Set()) => {
  if (value === null) return 'null';
  if (value !== Object(value)) {
    const tag = valueTag(value);
    if (tag === '[object Boolean]' || tag === '[object String]') return JSON.stringify(value);
    if (tag === '[object Number]') {
      if (!Number.isFinite(value)) throw new TypeError('Mutation input contains an unsupported value');
      return JSON.stringify(value);
    }
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError('Mutation input contains an unsupported value');
  }
  if (ancestors.has(value)) throw new TypeError('Mutation input contains an unsupported value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError('Mutation input contains an unsupported value');
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('Mutation input contains an unsupported value');
        }
        items.push(canonicalJson(descriptor.value, ancestors));
      }
      return `[${items.join(',')}]`;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => valueTag(key) !== '[object String]')) throw new TypeError('Mutation input contains an unsupported value');
    const keys = Object.keys(value).sort();
    if (keys.length !== ownKeys.length) throw new TypeError('Mutation input contains an unsupported value');
    return `{${keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Mutation input contains an unsupported value');
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`;
    }).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
};

const mutationError = (code, message, status = 409) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};

const conflictError = () => mutationError(
  'SOURCE_CONTROL_MUTATION_CONFLICT',
  'Source control mutation idempotency key was already used with different input',
);
const outcomeUnknownError = () => mutationError(
  'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN',
  'Source control mutation outcome is unknown',
);
const failedReplayError = (record) => mutationError(
  record.result?.failureCode || 'SOURCE_CONTROL_MUTATION_FAILED',
  'Source control mutation previously failed',
  record.result?.failureStatus || 409,
);

const failureResult = (error) => {
  const result = {};
  if (Number.isSafeInteger(error?.status) && error.status >= 400 && error.status <= 599) {
    result.failureStatus = error.status;
  }
  if (valueTag(error?.code) === '[object String]' && error.code.length > 0) result.failureCode = error.code;
  return Object.keys(result).length ? result : undefined;
};

export function digestMutationInput(value) {
  let canonical;
  try {
    canonical = canonicalJson(value);
  } catch {
    throw new TypeError('Mutation input contains an unsupported value');
  }
  return createHash('sha256').update(canonical).digest('hex');
}

export const mutationReceipt = (record, replayed, providerAccountId) => {
  if (valueTag(providerAccountId) !== '[object String]'
    || !providerAccountId || providerAccountId.trim() !== providerAccountId) {
    throw new TypeError('Mutation receipt requires a verified provider account ID');
  }
  return {
    status: 'succeeded',
    actor: {
      provider: record.actor.provider,
      instance: record.actor.instance,
      providerAccountId,
    },
    target: record.target,
    replayed,
    result: record.result,
  };
};

export function createMutationExecutor({ store, auditStore, runtimeIdentity }) {
  if (!store
    || !(store.claim instanceof Function)
    || !(store.complete instanceof Function)
    || !(store.withExecutionLock instanceof Function)
    || !(store.read instanceof Function)) {
    throw new TypeError('Mutation executor requires a store');
  }
  if ((auditStore || runtimeIdentity) && (!(auditStore?.plan instanceof Function)
    || !(auditStore.start instanceof Function) || !(auditStore.finish instanceof Function)
    || !(auditStore.read instanceof Function)
    || !isPlainObject(runtimeIdentity))) {
    throw new TypeError('Mutation executor audit dependencies are invalid');
  }
  const inFlight = new Map();

  const auditId = (record) => `provider:${record.key}`;
  const planAudit = async (record, providerAccountId) => {
    if (!auditStore) return null;
    if (valueTag(providerAccountId) !== '[object String]'
      || !providerAccountId || providerAccountId.trim() !== providerAccountId) {
      throw new TypeError('Mutation executor requires a verified provider account ID for audit');
    }
    const existing = await auditStore.read(auditId(record));
    const target = {
      kind: 'change-request',
      operation: record.kind,
      projectId: record.target.project.id,
    };
    for (const key of ['number', 'head', 'base', 'headSha']) {
      if (record.target[key] !== undefined) target[key] = record.target[key];
    }
    return auditStore.plan({
      id: auditId(record),
      initiator: 'user',
      executorKind: 'provider-api',
      // A restart resumes the original audit identity, not the new server's identity.
      runtime: existing?.runtime ?? runtimeIdentity,
      repositoryId: record.target.repositoryId,
      providerAccountId,
      transportReference: null,
      target,
    });
  };
  const finishAudit = async (record, step) => {
    if (!auditStore) return;
    let errorCode = null;
    if (record.state === 'failed') {
      errorCode = record.result?.failureCode ?? 'SOURCE_CONTROL_MUTATION_FAILED';
    } else if (record.state === 'outcome-unknown') {
      errorCode = 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN';
    }
    await auditStore.finish(auditId(record), {
      state: record.state,
      errorCode,
      steps: [step],
    });
  };

  const complete = async (record, completion, auditStep) => {
    let completed;
    try {
      completed = await store.complete(record.key, record.inputDigest, completion);
    } catch (error) {
      if (error?.code?.startsWith('SOURCE_CONTROL_LOCK_')) {
        error.message += ' Provider outcome could not be recorded. Use the same idempotency key for reconciliation; do not submit a new mutation.';
        throw error;
      }
      throw outcomeUnknownError();
    }
    await finishAudit(completed, auditStep);
    return completed;
  };

  const markOutcomeUnknown = async (record, auditStep) => {
    await complete(record, { state: 'outcome-unknown' }, auditStep);
    throw outcomeUnknownError();
  };

  const recover = async (record, reconcile) => {
    let reconciliation;
    try {
      if (!(reconcile instanceof Function)) throw new TypeError('Mutation reconciliation is required');
      reconciliation = await reconcile(record);
    } catch {
      return markOutcomeUnknown(record, 'provider-reconciliation');
    }
    if (!isPlainObject(reconciliation)
      || !['succeeded', 'failed', 'outcome-unknown'].includes(reconciliation.state)) {
      return markOutcomeUnknown(record, 'provider-reconciliation');
    }
    const completion = { state: reconciliation.state };
    if (reconciliation.result !== undefined) completion.result = reconciliation.result;
    const completed = await complete(record, completion, 'provider-reconciliation');
    if (completed.state === 'succeeded') return { record: completed, replayed: true };
    if (completed.state === 'failed') throw failedReplayError(completed);
    throw outcomeUnknownError();
  };

  const runOwner = async ({ record, providerAccountId, perform, reconcile, classifyError }) => {
    const claim = await store.claim(record);
    if (claim.status === 'conflict') throw conflictError();
    const auditClaim = await planAudit(claim.record, providerAccountId);
    const auditRecord = auditClaim?.record;
    if (claim.status === 'existing') {
      if (claim.record.state === 'running') {
        await auditStore?.start(auditId(claim.record));
        return recover(claim.record, reconcile);
      }
      if (!['succeeded', 'failed', 'outcome-unknown'].includes(claim.record.state)) throw conflictError();
      if (auditRecord && ['planned', 'running'].includes(auditRecord.state)) {
        await auditStore.start(auditId(claim.record));
        await finishAudit(claim.record, 'provider-request');
      }
      if (claim.record.state === 'succeeded') return { record: claim.record, replayed: true };
      if (claim.record.state === 'failed') throw failedReplayError(claim.record);
      throw outcomeUnknownError();
    }
    await auditStore?.start(auditId(claim.record));

    let result;
    try {
      result = await perform(claim.record);
    } catch (error) {
      let classification = 'failed';
      if (classifyError) {
        try {
          classification = await classifyError(error);
        } catch {
          classification = 'outcome-unknown';
        }
      }
      if (classification !== 'failed' && classification !== 'outcome-unknown') classification = 'outcome-unknown';
      if (classification === 'outcome-unknown') {
        return markOutcomeUnknown(claim.record, 'provider-request');
      }
      const completion = { state: 'failed' };
      const replayResult = failureResult(error);
      if (replayResult) completion.result = replayResult;
      await complete(claim.record, completion, 'provider-request');
      throw error;
    }
    const completed = await complete(claim.record, { state: 'succeeded', result }, 'provider-request');
    return { record: completed, replayed: false };
  };

  return {
    read(key) {
      return store.read(key);
    },
    execute(input) {
      if (auditStore && (valueTag(input.providerAccountId) !== '[object String]'
        || !input.providerAccountId || input.providerAccountId.trim() !== input.providerAccountId)) {
        return Promise.reject(new TypeError('Mutation executor requires a verified provider account ID for audit'));
      }
      const active = inFlight.get(input.record.key);
      if (active) {
        if (active.inputDigest !== input.record.inputDigest) return Promise.reject(conflictError());
        return active.promise.then(({ record }) => ({ record, replayed: true }));
      }
      const promise = store.withExecutionLock(input.record.key, () => runOwner(input));
      inFlight.set(input.record.key, { inputDigest: input.record.inputDigest, promise });
      return promise.finally(() => {
        if (inFlight.get(input.record.key)?.promise === promise) inFlight.delete(input.record.key);
      });
    },
  };
}
