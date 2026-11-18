import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withSourceControlFileLock } from './file-lock.js';
import { normalizeSourceControlProviderInstance } from './provider-instance.js';
import { bindingSummary, parseBinding, parseBindingStore } from './binding-contract.js';
import { createHttpsCredentialReference, parseGitCredentialReference } from '../git/credential-resolver.js';
import { hasSourceControlErrorCode } from './input-guards.js';
import type { BindingDraft, BindingStorageSnapshot, StoredBinding } from './binding-contract.js';
import type { AccountIdentity } from './provider-contract.js';

interface BindingStoreOptions {
  filePath: string;
  fsImpl?: typeof fs;
  lockWaitMs?: number;
}

type BindingRecord = BindingStorageSnapshot['repositories'][string];
type TransportGrant = StoredBinding['remotes'][number] | StoredBinding['auxiliary'][number];
type AdoptedAccount = AccountIdentity & { credentialRevision: number; providerUserId: string };

const invalidState = (cause: ErrorOptions['cause']) => Object.assign(new Error('Source control binding storage is invalid', { cause }), {
  code: 'INVALID_SOURCE_CONTROL_BINDINGS',
});
const providerInstancesMatch = (provider: string, left: string, right: string) => {
  try {
    return normalizeSourceControlProviderInstance(provider, left) === normalizeSourceControlProviderInstance(provider, right);
  } catch {
    return false;
  }
};
const credentialMatchesAccount = (candidate: TransportGrant, identity: AccountIdentity) => {
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

export function createBindingStore({ filePath, fsImpl = fs, lockWaitMs = 2_000 }: BindingStoreOptions) {
  let writes = Promise.resolve();
  const enqueueWrite = <Result>(operation: () => Promise<Result>) => {
    const next = writes.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, { fsImpl, waitMs: lockWaitMs }));
    writes = next.then(() => undefined, () => undefined);
    return next;
  };
  const writeState = async (state: BindingStorageSnapshot) => {
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
  const readState = async (): Promise<BindingStorageSnapshot> => {
    let encoded;
    try { encoded = await fsImpl.readFile(filePath, 'utf8'); }
    catch (error) {
      if (hasSourceControlErrorCode(error) && error.code === 'ENOENT') return { version: 2, repositories: {} };
      throw error;
    }
    const value = JSON.parse(encoded);
    let state;
    try { state = parseBindingStore(value); }
    catch (error) { throw invalidState(error); }
    return state;
  };
  const read = (repositoryId: string) => enqueueWrite(async () => (
    (await readState()).repositories[repositoryId] ?? { revision: 0, binding: null }
  ));
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
  function compareAndSwap(repositoryId: string, expectedRevision: number, binding: BindingDraft): Promise<{ revision: number; binding: StoredBinding }>;
  function compareAndSwap(repositoryId: string, expectedRevision: number, binding: null): Promise<{ revision: number; binding: null }>;
  function compareAndSwap(repositoryId: string, expectedRevision: number, binding: BindingDraft | null): Promise<BindingRecord>;
  function compareAndSwap(repositoryId: string, expectedRevision: number, binding: BindingDraft | null) {
    return enqueueWrite(async () => {
      const state = await readState();
      const current = state.repositories[repositoryId] ?? { revision: 0, binding: null };
      if (current.revision !== expectedRevision) {
        throw Object.assign(new Error('Source control binding changed'), {
          code: 'SOURCE_CONTROL_BINDING_CONFLICT', current,
        });
      }
      const revision = current.revision + 1;
      let nextBinding: StoredBinding | null = null;
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
  }

  const reconcileAccount = ({ provider, instance, accountId }: AccountIdentity) => enqueueWrite(async () => {
    const state = await readState();
    const changed: BindingRecord[] = [];
    const identity = { provider, instance, accountId };
    for (const [repositoryId, current] of Object.entries(state.repositories)) {
      const binding = current.binding;
      if (!binding) continue;
      let affected = false;
      const providers = binding.providers.map((candidate): StoredBinding['providers'][number] => {
        if (candidate.provider !== provider || !providerInstancesMatch(provider, candidate.instance, instance)
          || candidate.accountId !== accountId || candidate.readiness === 'account-unavailable') return candidate;
        affected = true;
        return { ...candidate, readiness: 'account-unavailable' };
      });
      const remotes = binding.remotes.map((candidate): StoredBinding['remotes'][number] => {
        if (!credentialMatchesAccount(candidate, identity) || candidate.readiness === 'confirmation-required') return candidate;
        affected = true;
        return { ...candidate, readiness: 'confirmation-required' };
      });
      const auxiliary = binding.auxiliary.map((candidate): StoredBinding['auxiliary'][number] => {
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

  const adoptAccount = ({ provider, instance, accountId, credentialRevision, providerUserId }: AdoptedAccount) => enqueueWrite(async () => {
    const state = await readState();
    const changed: BindingRecord[] = [];
    const credentialId = createHttpsCredentialReference({ provider, instance, credentialId: accountId, credentialRevision, providerUserId });
    const sameUserGone = (candidate: TransportGrant) => {
      if (candidate.mode !== 'managed' || !candidate.credentialId || candidate.readiness !== 'confirmation-required') return null;
      try {
        const reference = parseGitCredentialReference(candidate.credentialId);
        return reference.transport === 'https' && reference.provider === provider
          && providerInstancesMatch(provider, reference.instance, instance)
          && reference.providerUserId === providerUserId && reference.credentialId !== accountId
          ? { accountId: reference.credentialId, grant: candidate }
          : null;
      } catch {
        return null;
      }
    };
    for (const [repositoryId, current] of Object.entries(state.repositories)) {
      const binding = current.binding;
      if (!binding) continue;
      const goneAccounts = new Set<string>();
      function adoptGrant(candidate: StoredBinding['remotes'][number]): StoredBinding['remotes'][number];
      function adoptGrant(candidate: StoredBinding['auxiliary'][number]): StoredBinding['auxiliary'][number];
      function adoptGrant(candidate: TransportGrant): TransportGrant {
        const gone = sameUserGone(candidate);
        if (!gone) return candidate;
        goneAccounts.add(gone.accountId);
        return { ...gone.grant, credentialId, readiness: 'ready' };
      }
      const remotes = binding.remotes.map((candidate) => adoptGrant(candidate));
      const auxiliary = binding.auxiliary.map((candidate) => adoptGrant(candidate));
      const providers = binding.providers.map((candidate): StoredBinding['providers'][number] => (
        candidate.provider === provider && providerInstancesMatch(provider, candidate.instance, instance)
          && candidate.readiness === 'account-unavailable' && goneAccounts.has(candidate.accountId)
          ? { ...candidate, accountId, readiness: 'ready' }
          : candidate
      ));
      if (goneAccounts.size === 0) continue;
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

  return { read, listRemoteGrants, compareAndSwap, reconcileAccount, adoptAccount };
}
