import { useEffect, useState } from 'react';
import { getBranchBase } from '@/lib/gitApi';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { gitBaseBranchEntryKey, useGitBaseBranchStore } from '@/stores/useGitBaseBranchStore';
import { useGitStore } from '@/stores/useGitStore';

/** Shared base and freshness identity for Changes and the current-branch walkthrough. */
export function useBranchComparisonBase(directory: string | null, branch: string | null, enabled: boolean) {
  const runtimeKey = useGitStore((state) => state.runtimeKey);
  const statusFetchedAt = useGitStore((state) => enabled && directory
    ? state.directories.get(directory)?.lastStatusFetch ?? 0
    : 0);
  const key = JSON.stringify([runtimeKey, directory, branch]);
  const overrideKey = directory && branch ? gitBaseBranchEntryKey(directory, branch) : null;
  const override = useGitBaseBranchStore((state) => overrideKey ? state.overrides[overrideKey] ?? null : null);
  const [detected, setDetected] = useState<{ key: string; base: string | null } | null>(null);

  useEffect(() => {
    if (!enabled || !directory || !branch || override) return;
    let cancelled = false;
    const requestRuntime = getRuntimeKey();
    getBranchBase(directory, branch)
      .then(({ base }) => {
        if (cancelled || getRuntimeKey() !== requestRuntime) return;
        setDetected((previous) => previous?.key === key && previous.base === base ? previous : { key, base });
      })
      .catch(() => {
        if (cancelled || getRuntimeKey() !== requestRuntime) return;
        // Keep a same-branch answer on transient failure; a new branch needs a choice.
        setDetected((previous) => previous?.key === key ? previous : { key, base: null });
      });
    return () => { cancelled = true; };
  }, [branch, directory, enabled, key, override, statusFetchedAt]);

  return {
    base: override ?? (detected?.key === key ? detected.base : null),
    resolved: Boolean(override) || detected?.key === key,
    revision: JSON.stringify([runtimeKey, statusFetchedAt]),
  };
}
