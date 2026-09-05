import React from 'react';

import type { FileDiffMetadata } from '@pierre/diffs';

import {
  branchFileDiffFromPatch,
  branchRangeKey,
  candidateBranchesForBasePicker,
  isBranchScopeAvailable,
  isBranchScopeDefinitelyUnavailable,
  resolveRepositoryDefaultBranch,
  useRangeKeyedCache,
} from '@/components/views/branchDiffScope';
import { getBranchBase, getGitRangeDiff, getGitRangeFiles } from '@/lib/gitApi';
import type { GitRangeFileEntry } from '@/lib/api/types';
import { gitBaseBranchEntryKey, useGitBaseBranchStore } from '@/stores/useGitBaseBranchStore';
import { useGitBranches } from '@/stores/useGitStore';

/**
 * Reservation slot for a branch range diff while its fetch is in flight. It is
 * uniquely the placeholder: `branchFileDiffFromPatch` produces a non-null
 * `fileDiff` for text and a null `fileDiff` only for binary patches, so this
 * exact value can never be a real diff. `activeFileDiff` maps it to loading.
 */
const BRANCH_FILE_DIFF_PLACEHOLDER: BranchFileDiff = { fileDiff: null, isBinary: false };

/**
 * One file's range diff: either a parsed text diff or a binary marker with no
 * parseable content.
 */
export type BranchFileDiff = {
  fileDiff: FileDiffMetadata | null;
  isBinary: boolean;
};

/**
 * The currently-viewed file's diff through the branch scope, as a
 * discriminated union. `idle` means no file is being viewed or the branch
 * range is unavailable; `loading` covers both "not yet reserved" and "reserved
 * and in flight"; `ready` carries the resolved diff.
 */
export type BranchFileDiffStatus =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; value: BranchFileDiff };

export type UseMobileBranchDiffScopeArgs = {
  directory: string | null;
  /** `status?.current` — null while status has not settled or there is no branch. */
  currentBranch: string | null;
  /** `status?.tracking` — the raw value, may carry a '/' remote prefix. */
  trackingRemote: string | null;
  /** Repo-detection result from the git store. */
  isGitRepo: boolean | null;
  /**
   * `status !== null` — the settled test for "no branch yet". A detached HEAD
   * and a failed load both read as null; only a settled status may be treated
   * as "there is no branch".
   */
  isBranchStatusResolved: boolean;
  /** True only while the Branch mode is active (mirrors `activeDiffScope === 'branch'`). */
  isEnabled: boolean;
  /**
   * The currently-viewed file path (the diff detail's route path), null while
   * on the list. This single requested path drives the range-keyed diff cache.
   */
  activePath: string | null;
};

export type UseMobileBranchDiffScopeResult = {
  isBranchScopeAvailable: boolean;
  branchScopeDefinitelyUnavailable: boolean;
  detectedBranchBase: string | null;
  isBranchBaseResolved: boolean;
  baseOverride: string | null;
  branchBase: string | null;
  candidateBranches: string[];
  setBaseOverride: (base: string) => void;
  branchFiles: GitRangeFileEntry[] | null;
  branchFilesError: string | null;
  reloadBranchFiles: () => void;
  activeFileDiff: BranchFileDiffStatus;
};

/**
 * Owns the branch-scope data state machine for the mobile Changes surface,
 * mirroring the desktop context panel's inline logic. The caller owns the UI
 * scope state and its coercion; this hook only exposes the availability and
 * coercion signals plus the resolved range data.
 *
 * Branch metadata needs no bounded retry here: the mobile surface always runs
 * `ensureAll` (and therefore `fetchBranches`) on mount before any diff panel
 * can be the only thing on screen, so this hook just selects the cached
 * `branches` value. Desktop's context panel fetches it itself because it can
 * mount without GitView or the composer having done so. A failed fetch leaves
 * `branches` null, which reads as "default branch unknown", not "unavailable",
 * until the surface's user-initiated refresh retries it.
 */
export function useMobileBranchDiffScope(args: UseMobileBranchDiffScopeArgs): UseMobileBranchDiffScopeResult {
  const { directory, currentBranch, trackingRemote, isGitRepo, isBranchStatusResolved, isEnabled, activePath } = args;

  const branches = useGitBranches(directory);

  const repositoryDefaultBranch = React.useMemo(
    () => resolveRepositoryDefaultBranch(trackingRemote, branches?.defaultBranches),
    [branches?.defaultBranches, trackingRemote]
  );

  // Offered only while the default branch is known and the current branch is
  // not it: an unknown default must not flash the option on a guess while
  // branch metadata is still loading.
  const showBranchOption = isBranchScopeAvailable(currentBranch, repositoryDefaultBranch);

  // Coercion acts only on CONFIRMED unavailability: not a repository, a
  // settled status without a branch (detached HEAD / failed load), metadata
  // that settled without a default branch, or being on the known default.
  // While status/metadata are still loading a persisted branch scope survives.
  const branchScopeDefinitelyUnavailable = isGitRepo === false
    || isBranchScopeDefinitelyUnavailable(
      currentBranch,
      repositoryDefaultBranch,
      isBranchStatusResolved,
      branches !== null
    );

  const setBaseOverride = useGitBaseBranchStore((state) => state.setOverride);
  // Subscribe to the overrides map directly: `getOverride` reads `get()`
  // imperatively, so a memo over it never recomputes when the store changes
  // and a freshly picked base would be invisible until an unrelated rerender.
  // The key includes the current branch: a base picked for one feature branch
  // is not an answer for another branch of the same repository.
  const baseOverride = useGitBaseBranchStore(
    React.useCallback(
      (state) => (directory && currentBranch
        ? state.overrides[gitBaseBranchEntryKey(directory, currentBranch)] ?? null
        : null),
      [currentBranch, directory]
    )
  );

  const [detectedBranchBase, setDetectedBranchBase] = React.useState<string | null>(null);
  const [isBranchBaseResolved, setIsBranchBaseResolved] = React.useState(false);

  // Base resolution is gated on the option being offered (default branch
  // known, current branch differs) plus a directory and a branch; a cancelled
  // run discards its result on unmount or dependency change.
  React.useEffect(() => {
    if (!showBranchOption || !directory || !currentBranch) {
      setDetectedBranchBase(null);
      setIsBranchBaseResolved(false);
      return;
    }

    let cancelled = false;
    setIsBranchBaseResolved(false);
    getBranchBase(directory, currentBranch)
      .then((result) => {
        if (!cancelled) setDetectedBranchBase(result.base);
      })
      .catch(() => {
        if (!cancelled) setDetectedBranchBase(null);
      })
      .finally(() => {
        if (!cancelled) setIsBranchBaseResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [currentBranch, directory, showBranchOption]);

  // An explicit user choice outranks the detected source; both are real
  // answers from git or the user, never a main/master guess.
  const branchBase = baseOverride ?? detectedBranchBase;

  const handleSetBaseOverride = React.useCallback((base: string) => {
    if (directory && currentBranch) {
      setBaseOverride(directory, currentBranch, base);
    }
  }, [currentBranch, directory, setBaseOverride]);

  const [branchFiles, setBranchFiles] = React.useState<GitRangeFileEntry[] | null>(null);
  const [branchFilesError, setBranchFilesError] = React.useState<string | null>(null);

  // Shared by the enabled effect and the error-state Retry button; the fetch id
  // discards completions from a superseded run (base or head changed, or an
  // earlier retry is still in flight).
  const branchFilesFetchIdRef = React.useRef(0);
  const reloadBranchFiles = React.useCallback(() => {
    if (!directory || !currentBranch || !branchBase) return;
    const fetchId = branchFilesFetchIdRef.current + 1;
    branchFilesFetchIdRef.current = fetchId;
    setBranchFiles(null);
    setBranchFilesError(null);
    getGitRangeFiles(directory, { base: branchBase, head: currentBranch })
      .then((files) => {
        if (branchFilesFetchIdRef.current === fetchId) setBranchFiles(files);
      })
      .catch((error) => {
        if (branchFilesFetchIdRef.current === fetchId) {
          setBranchFilesError(error instanceof Error ? error.message : String(error));
        }
      });
  }, [branchBase, currentBranch, directory]);

  React.useEffect(() => {
    if (isEnabled) {
      reloadBranchFiles();
    }
  }, [isEnabled, reloadBranchFiles]);

  // Range diffs are fetched per requested file: unlike working/staged diffs
  // there is no per-file cache channel, so patch data lives in a range-keyed
  // local cache. Stale completions from a previous range cannot write into the
  // new range's cache (see useRangeKeyedCache).
  const branchDiffRangeKey = isEnabled && directory && currentBranch && branchBase
    ? branchRangeKey(directory, branchBase, currentBranch)
    : null;

  // Mobile views one file at a time (list -> diff navigation), so the requested
  // path is exactly the active one; useRangeKeyedCache splits the paths key on
  // '\0', which a single path satisfies.
  const pathsKey = branchDiffRangeKey && activePath ? activePath : '';

  const fetchBranchDiffEntry = React.useCallback(
    (filePath: string) => {
      if (!directory || !branchBase || !currentBranch) {
        return Promise.reject(new Error('branch range is unavailable'));
      }
      return getGitRangeDiff(directory, { base: branchBase, head: currentBranch, path: filePath })
        .then((response) => branchFileDiffFromPatch(filePath, response.diff));
    },
    [branchBase, currentBranch, directory]
  );

  const branchFileDiffCache = useRangeKeyedCache<BranchFileDiff>(
    branchDiffRangeKey,
    pathsKey,
    branchDiffRangeKey ? fetchBranchDiffEntry : null,
    BRANCH_FILE_DIFF_PLACEHOLDER
  );

  const activeFileDiff = React.useMemo<BranchFileDiffStatus>(() => {
    if (!branchDiffRangeKey || !activePath) {
      return { status: 'idle' };
    }
    const cached = branchFileDiffCache.get(activePath);
    if (cached === undefined || cached === BRANCH_FILE_DIFF_PLACEHOLDER) {
      return { status: 'loading' };
    }
    return { status: 'ready', value: cached };
  }, [activePath, branchDiffRangeKey, branchFileDiffCache]);

  return {
    isBranchScopeAvailable: showBranchOption,
    branchScopeDefinitelyUnavailable,
    detectedBranchBase,
    isBranchBaseResolved,
    baseOverride,
    branchBase,
    candidateBranches: candidateBranchesForBasePicker(branches?.all, currentBranch),
    setBaseOverride: handleSetBaseOverride,
    branchFiles,
    branchFilesError,
    reloadBranchFiles,
    activeFileDiff,
  };
}
