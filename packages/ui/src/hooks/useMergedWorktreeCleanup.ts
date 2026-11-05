import React from 'react';
import { z } from 'zod';
import { toast } from '@/components/ui';
import { formatMessage, useI18nStore, type I18nKey } from '@/lib/i18n';
import { normalizePath } from '@/lib/pathNormalization';
import { isCapacitorApp } from '@/lib/platform';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import {
  runMergedWorktreeCleanup,
  type MergedWorktreeCandidate,
  type MergedWorktreeCleanupDeps,
  type MergedWorktreeOutcome,
} from '@/lib/worktrees/mergedWorktreeCleanup';
import { getWorktreeDisplayName } from '@/lib/worktrees/worktreeManager';
import { archiveWorktreeWork, takeRestoredWorktree } from '@/lib/worktrees/worktreeArchive';
import { isWorktreeRemoving } from '@/lib/worktrees/worktreeRemovalState';
import { readWorktreeUse, sessionsInWorktree } from '@/lib/worktrees/worktreeUse';
import { useTrackedItems } from '@/lib/trackedItems/interest';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import type { WorktreeMetadata } from '@/types/worktree';
import {
  getBoundStatusKeysForBranches,
  getFreshestBranchStatusForDirectory,
  useBranchTrackedPulls,
  useGitHubPrStatusStore,
} from '@/stores/useGitHubPrStatusStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { readSourceControlProvider } from '@/lib/source-control/providers/registry';

const HANDLED_STORAGE_KEY = 'openchamber.mergedWorktreeCleanup.handled';
const HANDLED_LIMIT = 200;
const PASS_INTERVAL_MS = 60_000;
const PASS_DEBOUNCE_MS = 2_000;

const handledKey = (candidate: MergedWorktreeCandidate): string =>
  `${normalizePath(candidate.worktree.path) ?? candidate.worktree.path}#${candidate.prNumber}`;

const handledSchema = z.array(z.string());

const readHandled = (): string[] => {
  try {
    return handledSchema.safeParse(JSON.parse(getSafeStorage().getItem(HANDLED_STORAGE_KEY) ?? '[]')).data ?? [];
  } catch {
    return [];
  }
};

const writeHandled = (entries: string[]): void => {
  getSafeStorage().setItem(HANDLED_STORAGE_KEY, JSON.stringify(entries.slice(-HANDLED_LIMIT)));
};

// Delays before retrying a failed archive, the last one repeating.
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
// Failed archives of this app run, by handled key. A reload tries them again at once.
const failures = new Map<string, { attempts: number; retryAt: number }>();

type LinkedWorktree = { worktree: WorktreeMetadata; project: { id: string; path: string }; directory: string; branch: string };

// Linked worktrees the sidebar has discovered, in every project, collapsed ones included.
const listLinkedWorktrees = (
  projects = useProjectsStore.getState().projects,
  worktreesByProject = useSessionUIStore.getState().availableWorktreesByProject,
): LinkedWorktree[] => {
  const linked: LinkedWorktree[] = [];
  for (const [projectPath, worktrees] of worktreesByProject) {
    const project = projects.find((entry) => normalizePath(entry.path) === projectPath);
    if (!project) continue;
    for (const worktree of worktrees) {
      const directory = normalizePath(worktree.path);
      const branch = worktree.branch?.trim();
      if (!directory || !branch || directory === projectPath || worktree.worktreeStatus !== 'ready') continue;
      linked.push({ worktree, project: { id: project.id, path: project.path }, directory, branch });
    }
  }
  return linked;
};

// Linked worktrees whose branch PR is merged, by the status the sidebar and
// the background follow below keep fresh; this asks GitHub nothing itself.
const listCandidates = (): MergedWorktreeCandidate[] => {
  const prState = useGitHubPrStatusStore.getState();
  return listLinkedWorktrees().flatMap(({ worktree, project, directory, branch }) => {
    const status = getFreshestBranchStatusForDirectory(prState, directory, branch);
    const pr = status?.changeRequest ?? status?.pr;
    if (pr?.state !== 'merged') return [];
    return [{
      worktree,
      project,
      prNumber: pr.number,
      provider: status?.changeRequest?.provider ?? status?.identity?.provider ?? null,
      mergedHeadSha: pr.headSha ?? null,
    }];
  });
};

const NO_KEYS: string[] = [];

/**
 * The open PRs of every linked worktree, followed by the server while cleanup
 * is on, so a merge is seen in a project collapsed in the sidebar too. Only a
 * PR the app already knows is followed; finding a branch's first PR stays
 * with the rows on screen.
 */
const useFollowLinkedWorktreePulls = (active: boolean): void => {
  const projects = useProjectsStore((state) => state.projects);
  const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const targets = React.useMemo(
    () => (active ? listLinkedWorktrees(projects, worktreesByProject) : []),
    [active, projects, worktreesByProject],
  );
  const keysSignature = useGitHubPrStatusStore((state) => (
    targets.length > 0 ? getBoundStatusKeysForBranches(state, targets).sort().join('\n') : ''
  ));
  const keys = React.useMemo(() => (keysSignature ? keysSignature.split('\n') : NO_KEYS), [keysSignature]);
  useTrackedItems(useBranchTrackedPulls(keys), { background: true });
};

const report = (outcome: MergedWorktreeOutcome): void => {
  const dictionary = useI18nStore.getState().dictionary;
  const name = getWorktreeDisplayName(outcome.candidate.worktree);
  const params = { name, number: outcome.candidate.prNumber };
  const term = readSourceControlProvider(outcome.candidate.provider).terminology.changeRequest;
  const key = (base: I18nKey) => changeRequestCopy(base, term);
  if (outcome.kind === 'archived') {
    failures.delete(handledKey(outcome.candidate));
    toast.success(formatMessage(dictionary, key('sessions.mergedCleanup.toast.archivedTitle'), params), { description: name });
  } else if (failures.get(handledKey(outcome.candidate))?.attempts === 1) {
    // Retries stay quiet: one toast per failing worktree is enough.
    toast.error(formatMessage(dictionary, key('sessions.mergedCleanup.toast.failedTitle'), params), {
      description: outcome.error.message,
    });
  }
};

const createDeps = (): MergedWorktreeCleanupDeps => {
  const handled = new Set(readHandled());
  const isCurrentRuntime = captureRuntimeInstance();
  return {
    listCandidates,
    isHandled: (candidate) => {
      const key = handledKey(candidate);
      return handled.has(key) || (failures.get(key)?.retryAt ?? 0) > Date.now();
    },
    markHandled: (candidate) => {
      handled.add(handledKey(candidate));
      writeHandled([...handled]);
    },
    markFailed: (candidate) => {
      const key = handledKey(candidate);
      const attempts = (failures.get(key)?.attempts ?? 0) + 1;
      const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1];
      failures.set(key, { attempts, retryAt: Date.now() + delay });
    },
    getWorktreeSessions: (path) => sessionsInWorktree(useGlobalSessionsStore.getState().activeSessions, path),
    readWorktreeUse,
    isCurrentRuntime,
    isWorktreeRemoving,
    takeRestored: takeRestoredWorktree,
    archiveWorktree: async (candidate, sessions) => {
      // A background pass never opens the trust prompt.
      await archiveWorktreeWork({ project: candidate.project, worktree: candidate.worktree, sessions, askForTrust: false });
    },
    report,
  };
};

/**
 * Archives a worktree with its sessions once its PR is merged, when nobody
 * works there. Opt-in
 * (`mergedWorktreeCleanupEnabled`). Runs on desktop and web only: VS Code has
 * no worktrees, and a phone would race the desktop it drives for the same
 * worktree.
 */
export const useMergedWorktreeCleanup = ({ enabled }: { enabled: boolean }): void => {
  const settingEnabled = useUIStore((state) => state.mergedWorktreeCleanupEnabled);
  const active = enabled && settingEnabled && !isVSCodeRuntime() && !isCapacitorApp() && !isMobileSurfaceRuntime();
  useFollowLinkedWorktreePulls(active);

  React.useEffect(() => {
    if (!active) return;
    let disposed = false;
    let running = false;
    let rerun = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const pass = async () => {
      if (running) {
        rerun = true;
        return;
      }
      running = true;
      try {
        await runMergedWorktreeCleanup(createDeps());
      } catch (error) {
        console.warn('[MergedWorktreeCleanup] pass failed', error);
      } finally {
        running = false;
      }
      const next = rerun;
      rerun = false;
      if (next && !disposed) void pass();
    };
    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        if (!disposed) void pass();
      }, PASS_DEBOUNCE_MS);
    };

    // A PR turning merged, an agent going idle or a session closing can each
    // make a waiting worktree ready, so any of them asks for a pass.
    const unsubscribePr = useGitHubPrStatusStore.subscribe((state, previous) => {
      if (state.entries !== previous.entries) schedule();
    });
    const unsubscribeUi = useSessionUIStore.subscribe((state, previous) => {
      if (state.currentSessionId !== previous.currentSessionId
        || state.availableWorktreesByProject !== previous.availableWorktreesByProject) schedule();
    });
    // An agent going idle is no event here; a periodic pass catches it.
    const interval = setInterval(() => void pass(), PASS_INTERVAL_MS);
    void pass();

    return () => {
      disposed = true;
      unsubscribePr();
      unsubscribeUi();
      clearInterval(interval);
      if (debounce) clearTimeout(debounce);
    };
  }, [active]);
};
