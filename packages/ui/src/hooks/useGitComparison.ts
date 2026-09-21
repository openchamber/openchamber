import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitDiffResponse } from '@/lib/api/types';
import { getCommitFiles, getGitCommitDiff, getGitRangeDiff, getGitRangeFiles } from '@/lib/gitApi';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { WalkthroughSource } from '@/lib/walkthrough/types';
import { useGitStore } from '@/stores/useGitStore';
import { fetchPullRequestDiff } from '@/lib/diff/pullRequestDiff';
import { PullRequestSnapshotCache } from '@/lib/diff/pullRequestSnapshotCache';
import { gitPushScopeKey, subscribeGitPush } from '@/lib/gitPushEvents';

export type GitComparisonSource = Extract<WalkthroughSource, { kind: 'branch' | 'commit' | 'pr' }>;

export interface GitComparisonFile {
  path: string;
  status: string;
  previousPath?: string;
  insertions: number;
  deletions: number;
  patch?: string;
}

type ComparisonFiles =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; files: GitComparisonFile[]; revision: number; refreshing: boolean }
  | { key: string; status: 'error'; message: string };

/** File-list authority shared by the stacked desktop view and mobile drill-down. */
export function useGitComparison(directory: string | null, source: GitComparisonSource | null, enabled = true, revision = '') {
  const { t } = useI18n();
  const runtimeKey = useGitStore((state) => state.runtimeKey);
  const key = directory && source ? JSON.stringify([runtimeKey, directory, source]) : null;
  const pushScope = gitPushScopeKey(directory ?? '', runtimeKey);
  const sourceRef = useRef({ key, source, enabled, pushScope });
  sourceRef.current = { key, source, enabled, pushScope };
  const [result, setResult] = useState<ComparisonFiles | null>(null);
  const generation = useRef(0);
  const [prCache] = useState(() => new PullRequestSnapshotCache());
  const [pushRevision, setPushRevision] = useState(0);
  useEffect(() => subscribeGitPush((scope) => {
    prCache.invalidate(scope);
    if (scope !== sourceRef.current.pushScope || sourceRef.current.source?.kind !== 'pr') return;
    generation.current += 1;
    setPushRevision((value) => value + 1);
  }), [prCache]);

  const read = useCallback(async (force: boolean) => {
    const { key: targetKey, source: target, enabled: active } = sourceRef.current;
    if (!enabled || !active || !key || targetKey !== key || !directory || !target) return;
    const request = ++generation.current;
    const runtime = getRuntimeKey();
    setResult((previous) => previous?.key === key && previous.status === 'ready' ? { ...previous, refreshing: true } : { key, status: 'loading' });
    try {
      const files: GitComparisonFile[] = target.kind === 'pr'
        ? await prCache.load(pushScope, target, () => fetchPullRequestDiff(directory, target), force)
        : target.kind === 'branch'
        ? (await getGitRangeFiles(directory, { base: target.baseRef, head: target.headRef, includeWorkingTree: true }))
          .map((file) => ({ ...file, insertions: 0, deletions: 0 }))
        : (await getCommitFiles(directory, target.hash)).files
          .map((file) => ({ path: file.path, status: file.changeType, previousPath: file.previousPath, insertions: file.insertions, deletions: file.deletions }));
      if (generation.current !== request || getRuntimeKey() !== runtime) return;
      setResult((previous) => previous?.key === key && previous.status === 'ready' && previous.files === files
        ? { ...previous, refreshing: false }
        : { key, status: 'ready', files, revision: request, refreshing: false });
    } catch (error) {
      if (generation.current !== request || getRuntimeKey() !== runtime) return;
      setResult({ key, status: 'error', message: error instanceof Error ? error.message : t('diffView.state.failedToLoadDiff') });
    }
  }, [directory, enabled, key, prCache, pushScope, t]);
  const refresh = useCallback(() => read(true), [read]);

  useEffect(() => {
    void read(false);
    return () => { generation.current += 1; };
  }, [read, revision, pushRevision]);

  const current = result?.key === key ? result : null;
  const files = current?.status === 'ready' ? current.files : null;
  const filesByPath = useMemo(() => new Map((files ?? []).map((file) => [file.path, file])), [files]);
  const fetchDiff = useCallback(async (filePath: string, contextLines = 3): Promise<GitDiffResponse> => {
    const { key: targetKey, source: target, enabled: active } = sourceRef.current;
    const file = filesByPath.get(filePath);
    if (!directory || targetKey !== key || !target || !file || !enabled || !active) throw new Error(t('diffView.state.failedToLoadDiff'));
    if (target.kind === 'pr') {
      if (file.patch === undefined) throw new Error(t('diffView.state.failedToLoadDiff'));
      return { diff: file.patch };
    }
    return target.kind === 'branch'
      ? getGitRangeDiff(directory, { base: target.baseRef, head: target.headRef, path: filePath, contextLines, includeWorkingTree: true })
      : getGitCommitDiff(directory, { hash: target.hash, path: filePath, previousPath: file.previousPath, contextLines });
  }, [directory, enabled, filesByPath, key, t]);

  return {
    key,
    revision: current?.status === 'ready' ? current.revision : 0,
    files,
    loading: Boolean(enabled && key && (!current || current.status === 'loading' || (current.status === 'ready' && current.refreshing))),
    error: current?.status === 'error' ? current.message : null,
    refresh,
    fetchDiff,
  };
}
