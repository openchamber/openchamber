import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitLogEntry } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useI18n } from '@/lib/i18n';
import { useGitStore } from '@/stores/useGitStore';
import { commitSelectionKey, useCommitSelectionStore } from '@/stores/useCommitSelectionStore';
import { useRuntimeAPIs } from './useRuntimeAPIs';

type CommitHistory =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; commits: GitLogEntry[]; loadingMore?: boolean }
  | { key: string; status: 'error'; message: string };
const NO_COMMITS: GitLogEntry[] = [];

export function useCommitComparison(directory: string | null, branch: string | null, enabled: boolean, preferredHash?: string, maxCount = 50) {
  const { git } = useRuntimeAPIs();
  const { t } = useI18n();
  const runtimeKey = useGitStore((state) => state.runtimeKey);
  const key = commitSelectionKey(directory ?? '', branch, runtimeKey);
  const selectedCommit = useCommitSelectionStore((state) => state.selections.get(key) ?? null);
  const selectCommit = useCommitSelectionStore((state) => state.select);
  const [history, setHistory] = useState<CommitHistory | null>(null);
  const requestId = useRef(0);
  const preferredHashRef = useRef(preferredHash);
  preferredHashRef.current = preferredHash;
  const refresh = useCallback(async () => {
    if (!directory || !enabled) return;
    const id = ++requestId.current;
    const requestRuntime = getRuntimeKey();
    setHistory((previous) => (previous?.key === key && previous.status === 'ready'
      ? { ...previous, loadingMore: true }
      : { key, status: 'loading' }));
    try {
      const to = branch && branch !== 'HEAD' ? `refs/heads/${branch}` : 'HEAD';
      if (!git.getGitLog) {
        setHistory({ key, status: 'error', message: t('commitComparison.loadError') });
        return;
      }
      const result = await git.getGitLog(directory, { maxCount, to });
      if (requestId.current !== id || getRuntimeKey() !== requestRuntime) return;
      const commits = result.all.slice(0, maxCount);
      setHistory({ key, status: 'ready', commits });
      if (!useCommitSelectionStore.getState().selections.has(key)) {
        const initial = preferredHashRef.current
          ? commits.find((commit) => commit.hash === preferredHashRef.current)
          : commits[0];
        if (initial) selectCommit(key, initial);
      }
    } catch (error) {
      if (requestId.current !== id || getRuntimeKey() !== requestRuntime) return;
      setHistory({ key, status: 'error', message: error instanceof Error ? error.message : t('commitComparison.loadError') });
    }
  }, [branch, directory, enabled, git, key, maxCount, selectCommit, t]);

  useEffect(() => {
    void refresh();
    return () => { requestId.current += 1; };
  }, [refresh]);

  const current = history?.key === key ? history : null;
  return {
    selectedCommit,
    commits: current?.status === 'ready' ? current.commits : NO_COMMITS,
    loading: enabled && (!current || current.status === 'loading' || (current.status === 'ready' && current.loadingMore === true)),
    hasMore: current?.status === 'ready' && current.commits.length >= maxCount,
    error: current?.status === 'error' ? current.message : null,
    refresh,
    select: (commit: GitLogEntry) => selectCommit(key, commit),
  };
}
