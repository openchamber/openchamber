import React from 'react';
import { z } from 'zod';
import { toast } from '@/components/ui';
import { formatMessage, useI18nStore, type I18nKey } from '@/lib/i18n';
import { getGitLog, getGitStatus } from '@/lib/gitApi';
import { normalizePath } from '@/lib/pathNormalization';
import { isCapacitorApp } from '@/lib/platform';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import {
  runMergedWorktreeCleanup,
  type MergedWorktreeCandidate,
  type MergedWorktreeCleanupDeps,
  type MergedWorktreeOutcome,
} from '@/lib/worktrees/mergedWorktreeCleanup';
import { getWorktreeDisplayName, removeProjectWorktree } from '@/lib/worktrees/worktreeManager';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { getFreshestPrStatusForBranch, useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { archiveSessions, getSessionLiveActivity } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';

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

// Linked worktrees the sidebar already knows, whose branch PR is merged. The
// PR status comes from what the sidebar keeps fresh; this asks GitHub nothing.
const listCandidates = (): MergedWorktreeCandidate[] => {
  const projects = useProjectsStore.getState().projects;
  const entries = useGitHubPrStatusStore.getState().entries;
  const candidates: MergedWorktreeCandidate[] = [];
  for (const [projectPath, worktrees] of useSessionUIStore.getState().availableWorktreesByProject) {
    const project = projects.find((entry) => normalizePath(entry.path) === projectPath);
    if (!project) continue;
    for (const worktree of worktrees) {
      const worktreePath = normalizePath(worktree.path);
      const branch = worktree.branch?.trim();
      if (!worktreePath || !branch || worktreePath === projectPath || worktree.worktreeStatus !== 'ready') continue;
      const status = getFreshestPrStatusForBranch(entries, worktreePath, branch);
      const pr = status?.pr;
      if (pr?.state !== 'merged') continue;
      candidates.push({
        worktree,
        project: { id: project.id, path: project.path },
        prNumber: pr.number,
        provider: status?.changeRequest?.provider ?? null,
        mergedHeadSha: pr.headSha ?? null,
      });
    }
  }
  return candidates;
};

const report = (outcome: MergedWorktreeOutcome): void => {
  const dictionary = useI18nStore.getState().dictionary;
  const name = getWorktreeDisplayName(outcome.candidate.worktree);
  const params = { name, number: outcome.candidate.prNumber };
  const key = (base: I18nKey) => changeRequestCopy(base, outcome.candidate.provider);
  if (outcome.kind === 'removed') {
    toast.success(formatMessage(dictionary, key('sessions.mergedCleanup.toast.removedTitle'), params), {
      description: formatMessage(dictionary, 'sessions.mergedCleanup.toast.removedDescription', params),
    });
  } else if (outcome.kind === 'archived') {
    toast.info(formatMessage(dictionary, key('sessions.mergedCleanup.toast.archivedTitle'), params), {
      description: formatMessage(dictionary, key('sessions.mergedCleanup.toast.archivedDescription'), params),
    });
  } else {
    toast.error(formatMessage(dictionary, key('sessions.mergedCleanup.toast.failedTitle'), params), {
      description: outcome.error.message,
    });
  }
};

const createDeps = (): MergedWorktreeCleanupDeps => {
  const handled = new Set(readHandled());
  return {
    listCandidates,
    isHandled: (candidate) => handled.has(handledKey(candidate)),
    markHandled: (candidate) => {
      handled.add(handledKey(candidate));
      writeHandled([...handled]);
    },
    getActiveSessions: () => useGlobalSessionsStore.getState().activeSessions,
    // "unknown" is not idle: without a live status answer the agent may be running.
    isSessionIdle: (sessionId) => getSessionLiveActivity(sessionId) === 'idle',
    isWorktreeOpen: (path) => normalizePath(useDirectoryStore.getState().currentDirectory ?? null) === normalizePath(path),
    isSessionOpen: (sessionId) => useSessionUIStore.getState().currentSessionId === sessionId,
    readWorktreeState: async (path) => {
      const [status, log] = await Promise.all([
        getGitStatus(path, { fresh: true }),
        getGitLog(path, { maxCount: 1 }),
      ]);
      return { isDirty: !status.isClean, headCommit: log.latest?.hash ?? null };
    },
    archiveSessions: (sessionIds) => archiveSessions(sessionIds),
    removeWorktree: (candidate) => removeProjectWorktree(candidate.project, candidate.worktree, { deleteLocalBranch: true }),
    report,
  };
};

/**
 * Archives a worktree's sessions once its PR is merged, and removes the
 * worktree with its local branch when nothing there can be lost. Opt-in
 * (`mergedWorktreeCleanupEnabled`). Runs on desktop and web only: VS Code has
 * no worktrees, and a phone would race the desktop it drives for the same
 * worktree.
 */
export const useMergedWorktreeCleanup = ({ enabled }: { enabled: boolean }): void => {
  const settingEnabled = useUIStore((state) => state.mergedWorktreeCleanupEnabled);
  const active = enabled && settingEnabled && !isVSCodeRuntime() && !isCapacitorApp() && !isMobileSurfaceRuntime();

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
      if (rerun && !disposed) {
        rerun = false;
        void pass();
      }
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
    const interval = setInterval(() => void pass(), PASS_INTERVAL_MS);
    schedule();

    return () => {
      disposed = true;
      unsubscribePr();
      unsubscribeUi();
      clearInterval(interval);
      if (debounce) clearTimeout(debounce);
    };
  }, [active]);
};
