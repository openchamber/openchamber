import React from 'react';
import type { GitAPI, SourceControlAPI } from '@/lib/api/types';
import { isGitOperationUnresolved, refreshGitOperation, type GitOperationRead } from '@/lib/boundGitNetworkOperation';
import { getRuntimeKey, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { gitOperationRecoveryOwner, type PendingGitReference } from '@/lib/source-control/git-operation-recovery';

export type GitActionRecovery = {
  reads: GitOperationRead[];
  localCommit: boolean;
  executing: boolean;
  checking: boolean;
  pending?: PendingGitReference[];
  problem?: 'storage' | 'capacity' | 'reconciling' | 'repository' | null;
};

const EMPTY_RECOVERY: GitActionRecovery = { reads: [], localCommit: false, executing: false, checking: false };

export function useGitOperationRecovery(
  directory: string | null | undefined,
  git: Pick<GitAPI, 'getNetworkOperation' | 'cancelNetworkOperation'>,
  sourceControl: Pick<SourceControlAPI, 'repositoryBinding'>,
  { owner = gitOperationRecoveryOwner, kind = 'repository' }: { owner?: typeof gitOperationRecoveryOwner; kind?: 'repository' | 'clone' } = {},
) {
  const runtime = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const stored = React.useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const key = JSON.stringify([runtime, directory, kind]);
  const [scope, setScope] = React.useState<{ key: string; runtimeKey: string; repositoryId: string | null } | null>(null);
  const [scopeFailed, setScopeFailed] = React.useState(false);
  const [entries, setEntries] = React.useState<Map<string, GitActionRecovery>>(() => new Map());
  const currentEntries = React.useRef(entries);
  const currentScope = React.useRef(key);
  const revision = React.useRef(0);
  currentScope.current = key;
  const write = React.useCallback((scope: string, entry: GitActionRecovery) => {
    const next = new Map(currentEntries.current);
    next.set(scope, entry);
    currentEntries.current = next;
    setEntries(next);
  }, []);
  const pending = scope?.key === key ? stored.references.filter((reference) => reference.runtimeKey === scope.runtimeKey && reference.repositoryId === scope.repositoryId) : [];
  const local = entries.get(key);
  const problem = stored.problem ?? (scope?.key !== key ? scopeFailed ? 'repository' : 'reconciling' : null);
  const entry: GitActionRecovery | undefined = local || pending.length || problem
    ? { ...(local ?? EMPTY_RECOVERY), pending, problem } : undefined;
  const blocked = Boolean(!stored.ready || problem || pending.length || local?.executing || local?.checking || local?.reads.some(isGitOperationUnresolved));

  React.useEffect(() => subscribeRuntimeEndpointWillChange(() => {
    revision.current += 1;
    const next = new Map(currentEntries.current);
    let changed = false;
    for (const [scope, entry] of next) {
      if (!entry.reads.some(isGitOperationUnresolved)) continue;
      next.set(scope, { ...entry, reads: entry.reads.map((read) => isGitOperationUnresolved(read) ? { ...read, availability: 'unavailable' } : read) });
      changed = true;
    }
    if (changed) { currentEntries.current = next; setEntries(next); }
  }), []);
  const resolveScope = React.useCallback(async () => {
    owner.hydrate();
    if (!directory) return;
    const capturedRevision = revision.current;
    try {
      const [runtimeKey, repositoryId] = await Promise.all([owner.runtimeKey(runtime), kind === 'clone'
        ? Promise.resolve(null) : sourceControl.repositoryBinding(directory).then((binding) => binding.repository.repositoryId)]);
      if (currentScope.current !== key || getRuntimeKey() !== runtime || revision.current !== capturedRevision) return;
      setScope({ key, runtimeKey, repositoryId });
      setScopeFailed(false);
    } catch {
      if (currentScope.current === key) setScopeFailed(true);
    }
  }, [directory, key, kind, owner, runtime, sourceControl]);
  React.useEffect(() => { void resolveScope(); }, [resolveScope]);

  const reconcile = React.useCallback(async (references: PendingGitReference[]) => {
    const capturedRevision = revision.current;
    const isCurrent = () => getRuntimeKey() === runtime && revision.current === capturedRevision;
    write(key, { ...(currentEntries.current.get(key) ?? EMPTY_RECOVERY), checking: true });
    for (const reference of references) {
      const read = await owner.reconcile(reference, git, runtime, isCurrent);
      if (!read || !isCurrent()) continue;
      const latest = currentEntries.current.get(key) ?? EMPTY_RECOVERY;
      const previous = latest.reads.find((previous) => previous.operation.operationId === read.operation.operationId);
      if (previous?.availability === 'available' && previous.operation.state !== 'planned' && previous.operation.state !== 'running') continue;
      const reads = latest.reads.filter((previous) => previous.operation.operationId !== read.operation.operationId);
      write(key, { ...latest, reads: [...reads, read] });
    }
    const latest = currentEntries.current.get(key);
    if (latest) write(key, { ...latest, checking: false });
  }, [git, key, owner, runtime, write]);
  React.useEffect(() => {
    if (scope?.key !== key || !stored.ready) return;
    const reads = currentEntries.current.get(key)?.reads ?? [];
    const restored = stored.references.filter((reference) => reference.runtimeKey === scope.runtimeKey
      && reference.repositoryId === scope.repositoryId && !reads.some((read) => read.operation.operationId === reference.operationId && read.availability === 'available'));
    if (restored.length) void reconcile(restored);
  }, [key, scope, stored.references, stored.ready, reconcile]);

  const start = () => {
    const previous = currentEntries.current.get(key);
    if (blocked || currentScope.current !== key || getRuntimeKey() !== runtime || previous?.executing || previous?.checking || previous?.reads.some(isGitOperationUnresolved)) return null;
    try { owner.assertWritable(); } catch { return null; }
    if (!scope || owner.getSnapshot().references.some((reference) => reference.runtimeKey === scope.runtimeKey && reference.repositoryId === scope.repositoryId)) return null;
    let action: GitActionRecovery = { ...EMPTY_RECOVERY, executing: true };
    const capturedRevision = revision.current;
    write(key, action);
    const update = (change: Partial<GitActionRecovery>) => {
      action = { ...action, ...change };
      write(key, action);
    };
    return {
      isCurrent: () => currentScope.current === key && getRuntimeKey() === runtime && revision.current === capturedRevision,
      onOperation: (read: GitOperationRead) => {
        if (read.runtimeKey !== runtime) return;
        action = currentEntries.current.get(key) ?? action;
        const reads = [...action.reads];
        const index = reads.findIndex((previous) => previous.operation.operationId === read.operation.operationId);
        if (index < 0) reads.push(read);
        else {
          const previous = reads[index];
          if (previous.availability === 'available' && previous.operation.state !== 'planned' && previous.operation.state !== 'running'
            && previous.operation !== read.operation) return;
          reads[index] = read;
        }
        update({ reads });
      },
      commitCreated: () => update({ localCommit: true }),
      finish: () => {
        const latest = currentEntries.current.get(key);
        if (latest) { action = latest; update({ executing: false }); }
      },
    };
  };

  const check = async (action: 'refresh' | 'cancel') => {
    if (currentScope.current !== key || getRuntimeKey() !== runtime) return;
    if (scope?.key !== key || !stored.ready) {
      await resolveScope();
      if (scope?.key !== key || !owner.getSnapshot().ready) return;
      if (action === 'refresh') {
        await reconcile(owner.getSnapshot().references.filter((reference) => reference.runtimeKey === scope.runtimeKey && reference.repositoryId === scope.repositoryId));
        return;
      }
    }
    const previous = currentEntries.current.get(key);
    if (previous?.checking) return;
    if (action === 'refresh' && pending.length) { await reconcile(pending); return; }
    const read = previous?.reads.at(-1);
    if (!directory || !previous || !read) return;
    write(key, { ...previous, checking: true });
    let next: GitOperationRead = { ...read, availability: 'unavailable' };
    const capturedRevision = revision.current;
    const isCurrent = () => currentScope.current === key && getRuntimeKey() === runtime && revision.current === capturedRevision;
    try {
      const repositoryId = kind === 'clone' ? null : (await sourceControl.repositoryBinding(directory)).repository.repositoryId;
      if (isCurrent() && repositoryId === ('repositoryId' in read.operation.target ? read.operation.target.repositoryId : null)) {
        next = await refreshGitOperation(git, read, action, getRuntimeKey, isCurrent);
        await owner.complete(next, isCurrent);
      }
    } catch { /* Failed reads and writes retain the durable blocker. */ }
    const latest = currentEntries.current.get(key);
    if (!latest) return;
    const reads = latest.reads.map((previous) => {
      if (previous.operation.operationId !== read.operation.operationId) return previous;
      if (previous !== read && previous.availability === 'available' && previous.operation.state !== 'planned' && previous.operation.state !== 'running') return previous;
      return next;
    });
    write(key, { ...latest, reads, checking: false });
  };

  React.useEffect(() => {
    const online = () => { if (pending.length || currentEntries.current.get(key)?.reads.some(isGitOperationUnresolved)) void check('refresh'); };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  });
  return { entry, blocked, start, refresh: () => check('refresh'), cancel: () => check('cancel') };
}
