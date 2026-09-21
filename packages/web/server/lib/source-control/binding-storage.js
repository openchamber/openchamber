import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withSourceControlFileLock } from './file-lock.js';
import { normalizeSourceControlProviderInstance } from './provider-instance.js';
import { bindingSummary, parseBinding, parseBindingStore } from './binding-contract.js';
import { parseGitCredentialReference } from '../git/credential-resolver.js';

const invalidState = (cause) => Object.assign(new Error('Source control binding storage is invalid', { cause }), {
  code: 'INVALID_SOURCE_CONTROL_BINDINGS',
});
const providerInstancesMatch = (provider, left, right) => {
  try {
    return normalizeSourceControlProviderInstance(provider, left) === normalizeSourceControlProviderInstance(provider, right);
  } catch {
    return false;
  }
};
const credentialMatchesAccount = (candidate, identity) => {
  if (candidate.mode !== 'managed' || !candidate.credentialId) return false;
  try {
    const reference = parseGitCredentialReference(candidate.credentialId);
    return reference.transport === 'https'
      && reference.provider === identity.provider
      && providerInstancesMatch(identity.provider, reference.instance, identity.instance)
      && reference.credentialId === identity.accountId;
  } catch {
    return false;
  }
};

export function createBindingStore({ filePath, fsImpl = fs, lockWaitMs = 2_000 }) {
  let writes = Promise.resolve();
  const enqueueWrite = (operation) => {
    const next = writes.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, { fsImpl, waitMs: lockWaitMs }));
    writes = next.then(() => undefined, () => undefined);
    return next;
  };
  const writeState = async (state) => {
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fsImpl.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fsImpl.chmod(temporary, 0o600);
      await fsImpl.rename(temporary, filePath);
    } catch (error) {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  };
  const readState = async () => {
    let encoded;
    try { encoded = await fsImpl.readFile(filePath, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return { version: 2, repositories: {} };
      throw error;
    }
    const value = JSON.parse(encoded);
    let state;
    try { state = parseBindingStore(value); }
    catch (error) { throw invalidState(error); }
    return state;
  };
  // Account reconciliation uses the same complete-file transaction.
  const read = (repositoryId) => enqueueWrite(async () => (
    (await readState()).repositories[repositoryId] ?? { revision: 0, binding: null }
  ));
  /**
   * Every remote grant the store holds, without the repositories they belong
   * to. Only the endpoint and mode leave: the caller decides which hosts
   * OpenChamber answers for, and nothing else about a repository is its
   * business.
   */
  const listRemoteGrants = () => enqueueWrite(async () => {
    const grants = [];
    for (const record of Object.values((await readState()).repositories)) {
      for (const remote of record.binding?.remotes ?? []) {
        grants.push(Object.freeze({ mode: remote.mode, displayUrl: remote.fetch.displayUrl }));
        if (remote.push.displayUrl !== remote.fetch.displayUrl) {
          grants.push(Object.freeze({ mode: remote.mode, displayUrl: remote.push.displayUrl }));
        }
      }
    }
    return Object.freeze(grants);
  });
  const compareAndSwap = (repositoryId, expectedRevision, binding) => enqueueWrite(async () => {
    const state = await readState();
    const current = state.repositories[repositoryId] ?? { revision: 0, binding: null };
    if (current.revision !== expectedRevision) {
      throw Object.assign(new Error('Source control binding changed'), {
        code: 'SOURCE_CONTROL_BINDING_CONFLICT', current,
      });
    }
    const revision = current.revision + 1;
    let nextBinding = null;
    if (binding !== null) {
      try { nextBinding = parseBinding({ ...binding, repositoryId, revision }); }
      catch (error) { throw invalidState(error); }
      nextBinding.state = bindingSummary(nextBinding);
    }
    const record = { revision, binding: nextBinding };
    state.repositories[repositoryId] = record;
    await writeState(state);
    return record;
  });

  const reconcileAccount = ({ provider, instance, accountId }) => enqueueWrite(async () => {
    const state = await readState();
    const changed = [];
    const identity = { provider, instance, accountId };
    for (const [repositoryId, current] of Object.entries(state.repositories)) {
      const binding = current.binding;
      if (!binding) continue;
      let affected = false;
      const providers = binding.providers.map((candidate) => {
        if (candidate.provider !== provider || !providerInstancesMatch(provider, candidate.instance, instance)
          || candidate.accountId !== accountId || candidate.readiness === 'account-unavailable') return candidate;
        affected = true;
        return { ...candidate, readiness: 'account-unavailable' };
      });
      const remotes = binding.remotes.map((candidate) => {
        if (!credentialMatchesAccount(candidate, identity) || candidate.readiness === 'confirmation-required') return candidate;
        affected = true;
        return { ...candidate, readiness: 'confirmation-required' };
      });
      const auxiliary = binding.auxiliary.map((candidate) => {
        if (!credentialMatchesAccount(candidate, identity) || candidate.readiness === 'confirmation-required') return candidate;
        affected = true;
        return { ...candidate, readiness: 'confirmation-required' };
      });
      if (!affected) continue;
      const revision = current.revision + 1;
      const nextBinding = { ...binding, providers, remotes, auxiliary, revision };
      nextBinding.state = bindingSummary(nextBinding);
      const record = { revision, binding: nextBinding };
      state.repositories[repositoryId] = record;
      changed.push(record);
    }
    if (changed.length) await writeState(state);
    return changed;
  });

  return { read, listRemoteGrants, compareAndSwap, reconcileAccount };
}
