import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { SourceControlAPI, SourceControlBindingRead, SourceControlReadContext } from '@/lib/api/types';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { getBoundSourceControlReadContexts } from './identity';

type BindingAPI = Pick<SourceControlAPI, 'repositoryBinding'>;
type BindingScope = { runtimeKey: string; directory: string; generation: number };
type BindingMutationScope = BindingScope & { expectedRepositoryId: string; expectedRevision: number; release: () => void };
type BindingState = (
  | { status: 'idle'; read: null; error: null }
  | { status: 'loading'; read: SourceControlBindingRead | null; error: Error | null }
  | { status: 'ready'; read: SourceControlBindingRead; error: null }
  | { status: 'stale'; read: SourceControlBindingRead; error: null }
  | { status: 'error'; read: SourceControlBindingRead | null; error: Error }
) & { contexts: SourceControlReadContext[] };
const EMPTY_CONTEXTS: SourceControlReadContext[] = [];
const IDLE: BindingState = { status: 'idle', read: null, error: null, contexts: EMPTY_CONTEXTS };
type Entry = {
  scope: BindingScope;
  state: BindingState;
  listeners: Set<() => void>;
  pending?: Promise<BindingState>;
  revision: number;
  mutations: number;
};

// Directory demand owns retention. Repository identity joins known worktrees only
// after a server read, never from path guesses.
export class RepositoryBindingOwner {
  generation = 0;
  private entries = new Map<string, Entry>();
  private repositories = new Map<string, Set<Entry>>();
  private resetListeners = new Set<() => void>();
  private trimScheduled = false;

  constructor(private runtimeKey = getRuntimeKey, private idleLimit = 64) {}

  scope(directory: string): BindingScope {
    return { runtimeKey: this.runtimeKey(), directory, generation: this.generation };
  }

  private key(scope: BindingScope) { return JSON.stringify([scope.runtimeKey, scope.directory]); }
  private repositoryKey(scope: BindingScope, repositoryId: string) { return JSON.stringify([scope.runtimeKey, repositoryId]); }
  private current(scope: BindingScope) {
    return scope.generation === this.generation && scope.runtimeKey === this.runtimeKey();
  }

  snapshot = (scope: BindingScope): BindingState => this.current(scope)
    ? this.entries.get(this.key(scope))?.state ?? IDLE : IDLE;

  private entry(scope: BindingScope): Entry {
    const key = this.key(scope);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { scope, state: IDLE, listeners: new Set(), revision: 0, mutations: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }

  subscribe = (scope: BindingScope, listener: () => void): (() => void) => {
    if (!this.current(scope) || !scope.directory) return () => {};
    const entry = this.entry(scope);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size && entry.state.status === 'ready') {
        entry.state = { ...entry.state, status: 'stale', contexts: EMPTY_CONTEXTS };
      }
      this.scheduleTrim();
    };
  };

  subscribeReset = (listener: () => void): (() => void) => {
    this.resetListeners.add(listener);
    return () => { this.resetListeners.delete(listener); };
  };

  private publish(entry: Entry, state: BindingState) {
    entry.state = state;
    for (const listener of entry.listeners) listener();
  }

  private unlink(entry: Entry) {
    const repositoryId = entry.state.read?.repository.repositoryId;
    if (!repositoryId) return;
    const key = this.repositoryKey(entry.scope, repositoryId);
    const entries = this.repositories.get(key);
    entries?.delete(entry);
    if (!entries?.size) this.repositories.delete(key);
  }

  private commit(entry: Entry, read: SourceControlBindingRead) {
    this.unlink(entry);
    const key = this.repositoryKey(entry.scope, read.repository.repositoryId);
    let entries = this.repositories.get(key);
    if (!entries) { entries = new Set(); this.repositories.set(key, entries); }
    entries.add(entry);
    this.publish(entry, { status: 'ready', read, error: null,
      contexts: getBoundSourceControlReadContexts(read, entry.scope.directory) });
  }

  private scheduleTrim() {
    if (this.trimScheduled) return;
    this.trimScheduled = true;
    setTimeout(() => {
      this.trimScheduled = false;
      let idle = 0;
      for (const entry of [...this.entries.values()].reverse()) {
        if (entry.listeners.size || entry.pending || entry.mutations) continue;
        if (++idle <= this.idleLimit) continue;
        this.unlink(entry);
        this.entries.delete(this.key(entry.scope));
      }
    }, 0);
  }

  read = (scope: BindingScope, api: BindingAPI, force = false): Promise<BindingState> => {
    if (!this.current(scope) || !scope.directory) return Promise.resolve(IDLE);
    const entry = this.entry(scope);
    if (entry.pending) return entry.pending;
    if (!force && entry.state.status !== 'idle' && entry.state.status !== 'stale') return Promise.resolve(entry.state);
    const revision = entry.revision;
    const pending = Promise.resolve().then(() => {
      if (!this.current(scope)) return null;
      return api.repositoryBinding(scope.directory);
    }).then((read) => {
      if (!read || !this.current(scope)) return IDLE;
      if (entry.revision !== revision) return entry.state;
      // A sibling worktree mutation may have completed before this directory's
      // first read established its repository identity.
      const siblings = this.repositories.get(this.repositoryKey(scope, read.repository.repositoryId));
      for (const sibling of siblings ?? []) {
        const newer = sibling.state.read;
        if (newer && newer.revision > read.revision) read = newer;
      }
      this.commit(entry, read);
      for (const sibling of [...siblings ?? []]) {
        if (sibling === entry) continue;
        sibling.revision += 1;
        this.commit(sibling, read);
      }
      return entry.state;
    }).catch((cause) => {
      if (!this.current(scope)) return IDLE;
      if (entry.revision !== revision) return entry.state;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.publish(entry, { status: 'error', read: entry.state.read, error, contexts: EMPTY_CONTEXTS });
      return entry.state;
    }).finally(() => {
      if (entry.pending === pending) entry.pending = undefined;
      this.scheduleTrim();
    });
    entry.pending = pending;
    this.publish(entry, { status: 'loading', read: entry.state.read, error: entry.state.error, contexts: EMPTY_CONTEXTS });
    return pending;
  };

  captureMutation(scope: BindingScope, read: SourceControlBindingRead): BindingMutationScope {
    const entry = this.current(scope) ? this.entries.get(this.key(scope)) : undefined;
    if (entry) entry.mutations += 1;
    let released = false;
    return { ...scope, expectedRepositoryId: read.repository.repositoryId, expectedRevision: read.revision,
      release: () => {
        if (released) return;
        released = true;
        if (entry) entry.mutations -= 1;
        this.scheduleTrim();
      },
    };
  }

  setMutationResult(scope: BindingMutationScope, read: SourceControlBindingRead): boolean {
    if (!this.current(scope) || read.repository.repositoryId !== scope.expectedRepositoryId
      || read.revision <= scope.expectedRevision) return false;
    const entry = this.entries.get(this.key(scope));
    if (!entry || entry.state.read?.repository.repositoryId !== scope.expectedRepositoryId) return false;
    const siblings = this.repositories.get(this.repositoryKey(scope, scope.expectedRepositoryId));
    for (const sibling of [...siblings ?? []]) {
      if ((sibling.state.read?.revision ?? -1) > read.revision) continue;
      sibling.revision += 1;
      this.commit(sibling, read);
    }
    return true;
  }

  reconcile = async (scope: BindingScope, api: BindingAPI): Promise<BindingState> => {
    if (!this.current(scope)) return IDLE;
    // A conflict requires a read started after the failed mutation, not an
    // already in-flight snapshot. Never retry the mutation itself.
    await this.entries.get(this.key(scope))?.pending;
    return this.read(scope, api, true);
  };

  reset = (): void => {
    this.generation += 1;
    const entries = this.entries;
    this.entries = new Map();
    this.repositories.clear();
    for (const listener of this.resetListeners) listener();
    for (const entry of entries.values()) for (const listener of entry.listeners) listener();
  };
}

export const repositoryBindingOwner = new RepositoryBindingOwner();

const generationSnapshot = () => repositoryBindingOwner.generation;

export const useRepositoryBinding = (directory: string | null | undefined, api: BindingAPI, enabled = true) => {
  const runtimeKey = useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const generation = useSyncExternalStore(repositoryBindingOwner.subscribeReset, generationSnapshot, generationSnapshot);
  const scope = useMemo(() => ({ runtimeKey, generation, directory: enabled ? directory ?? '' : '' }), [directory, enabled, generation, runtimeKey]);
  const subscribe = useCallback((listener: () => void) => repositoryBindingOwner.subscribe(scope, listener), [scope]);
  const snapshot = useCallback(() => repositoryBindingOwner.snapshot(scope), [scope]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (state.status === 'idle' || state.status === 'stale') void repositoryBindingOwner.read(scope, api);
  }, [api, scope, state.status]);
  const retry = useCallback(() => repositoryBindingOwner.reconcile(scope, api), [api, scope]);
  const isCurrent = useCallback(() => state.status === 'ready' && repositoryBindingOwner.snapshot(scope) === state, [scope, state]);
  return { ...state, scope, retry, isCurrent, stale: state.read !== null && state.status !== 'ready' };
};
