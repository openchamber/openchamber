import React from 'react';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { generatePullRequestDescription, getGitLog } from '@/lib/gitApi';
import { openExternalUrl } from '@/lib/url';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDeviceInfo } from '@/lib/device';
import { Icon } from "@/components/icon/Icon";
import { useUIStore } from '@/stores/useUIStore';
import { useOpenSourceControlSettings } from '@/hooks/useOpenSourceControlSettings';
import { useWalkthroughStore } from '@/stores/useWalkthroughStore';
import { WALKTHROUGH_ACTION_CLASS } from '@/components/views/walkthrough/walkthroughAction';
import { GitHubAccountControl } from '@/components/github/GitHubAccountControl';
import { useRepositoryHost } from '@/components/references/referenceSources';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useSessionUIStore } from '@/sync/session-ui-store';
import * as sessionActions from '@/sync/session-actions';
import { buildLinkedIssue } from '@/lib/linkedIssues';
import { normalizePath } from '@/lib/pathNormalization';
import { getSourceControlAuthKey, getSourceControlReadContextAuthState, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { getSourceControlStatusKey, useBranchTrackedPulls, useGitHubPrStatusStore, type SourceControlStatus } from '@/stores/useGitHubPrStatusStore';
import { useTrackedItems } from '@/lib/trackedItems/interest';
import type {
  CreateChangeRequestInput,
  Project,
  SourceControlAPI,
  SourceControlCapabilities,
  SourceControlReadContext,
} from '@/lib/api/types';
import { useI18n, type I18nKey, type I18nParams } from '@/lib/i18n';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { formatChangeRequestReference, getSourceControlProviderLabel } from '@/lib/source-control/identity';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getDetectedUpstreamContextKey, loadDetectedUpstreamRepo } from './detectedUpstreamRepo';
import type { ChangeRequest, SourceControlProvider } from '@/lib/source-control/types';
import { prVisualStateOf, type PrVisualState } from '@/lib/source-control/prVisualState';
import {
  hasUnknownMutationOutcomeCode,
  reconcileUnknownMutationOutcome,
} from './sourceControlMutationOutcome';
import { BranchPullRequestPreview } from './BranchPullRequestPreview';
import { useBranchPush } from './useBranchPush';

const statusColor = (state: string | undefined | null): string => {
  switch (state) {
    case 'success':
      return 'bg-[color:var(--status-success)]';
    case 'failure':
      return 'bg-[color:var(--status-error)]';
    case 'pending':
      return 'bg-[color:var(--status-warning)]';
    default:
      return 'bg-muted-foreground/40';
  }
};

// A change request opened here belongs to the session the user is working in,
// but only when that session works in this directory: the Git view can show
// another worktree than the open chat.
const linkCreatedChangeRequestToCurrentSession = (
  directory: string,
  changeRequest: { url: string; number: number; title: string },
) => {
  const { currentSessionId, getDirectoryForSession } = useSessionUIStore.getState();
  const sessionDirectory = currentSessionId ? getDirectoryForSession(currentSessionId) : null;
  if (!currentSessionId || !sessionDirectory || normalizePath(sessionDirectory) !== normalizePath(directory)) {
    return;
  }
  void sessionActions.setLinkedIssue(
    currentSessionId,
    sessionDirectory,
    buildLinkedIssue({ url: changeRequest.url, number: changeRequest.number, title: changeRequest.title, kind: 'pull', linkedAt: Date.now() }),
    true,
  ).catch(() => undefined);
};

const getPrVisualState = (status: SourceControlStatus | null): PrVisualState | null => {
  const pr = status?.changeRequest ?? status?.pr;
  if (!pr) {
    return null;
  }
  return prVisualStateOf({
    state: pr.state,
    draft: pr.draft,
    checksState: (status?.ci?.summary ?? status?.checks)?.state,
    mergeable: pr.mergeable,
    mergeableState: pr.mergeableState,
  });
};

const PR_ACTION_REFRESH_DELAYS_MS = [2_000, 5_000] as const;
let fallbackMutationKey = 0;

const createMutationKey = (): string => {
  const generated = globalThis.crypto?.randomUUID?.();
  if (generated) return generated;
  fallbackMutationKey += 1;
  return `source-control-${Date.now().toString(36)}-${fallbackMutationKey.toString(36)}`;
};

const createMutationSignature = (
  runtimeKey: string,
  context: SourceControlReadContext,
  details: Array<string | number | boolean | undefined>,
): string => JSON.stringify([
  'create',
  runtimeKey,
  context.provider,
  context.instance,
  context.directory,
  context.repositoryId,
  context.accountId,
  context.bindingRevision,
  context.primaryRemote,
  ...details,
]);

const CREATE_AS_DRAFT_KEY = 'openchamber:pr-create-as-draft:v1';

/** Whether new pull requests start as drafts: the last choice made, ready by default. */
const readCreateAsDraft = (): boolean => {
  try { return localStorage.getItem(CREATE_AS_DRAFT_KEY) === 'true'; } catch { return false; }
};

const rememberCreateAsDraft = (draft: boolean): void => {
  try { localStorage.setItem(CREATE_AS_DRAFT_KEY, String(draft)); } catch { /* convenience only */ }
};

const branchToTitle = (branch: string): string => {
  return branch
    .replace(/^refs\/heads\//, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

const normalizeBranchRef = (value: string): string => {
  let normalized = value.trim();
  if (!normalized) {
    return '';
  }
  if (normalized.startsWith('refs/heads/')) {
    normalized = normalized.slice('refs/heads/'.length);
  }
  if (normalized.startsWith('heads/')) {
    normalized = normalized.slice('heads/'.length);
  }
  if (normalized.startsWith('remotes/')) {
    normalized = normalized.slice('remotes/'.length);
  }
  return normalized;
};

const remoteBranchToName = (value: string, remoteName: string | null): string => {
  const normalized = normalizeBranchRef(value);
  if (!normalized || normalized.includes('->')) {
    return '';
  }

  if (remoteName) {
    const prefix = `${remoteName}/`;
    if (normalized.startsWith(prefix)) {
      return normalized.slice(prefix.length).trim();
    }
    return '';
  }

  const slashIndex = normalized.indexOf('/');
  if (slashIndex > 0) {
    return normalized.slice(slashIndex + 1).trim();
  }
  return normalized;
};

const getPullRequestSnapshotKey = (directory: string, branch: string): string => `${directory}::${branch}`;

type PullRequestDraftSnapshot = {
  title: string;
  body: string;
  draft: boolean;
  additionalContext: string;
  targetBaseBranch?: string;
};

const pullRequestDraftSnapshots = new Map<string, PullRequestDraftSnapshot>();

const openExternal = openExternalUrl;

function useDetectedUpstreamRepo(
  directory: string,
  sourceControl: SourceControlAPI,
  readContext: SourceControlReadContext | null,
) {
  const contextKey = readContext ? getDetectedUpstreamContextKey(readContext) : null;
  const [state, setState] = React.useState<{
    contextKey: string | null;
    detectedUpstream: Project | null;
    upstreamBranches: string[];
  }>({ contextKey: null, detectedUpstream: null, upstreamBranches: [] });

  React.useEffect(() => {
    if (!directory || !readContext || !contextKey) return;

    let cancelled = false;
    void (async () => {
      try {
        const result = await loadDetectedUpstreamRepo(sourceControl, readContext);
        if (!cancelled) setState({
          contextKey,
          detectedUpstream: result.upstream,
          upstreamBranches: result.branches,
        });
      } catch {
        // Preserve the last authoritative result for this context.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [contextKey, directory, readContext, sourceControl]);

  return state.contextKey === contextKey
    ? { detectedUpstream: state.detectedUpstream, upstreamBranches: state.upstreamBranches }
    : { detectedUpstream: null, upstreamBranches: [] };
}

export const PullRequestSection: React.FC<{
  directory: string;
  branch: string;
  baseBranch: string;
  trackingBranch?: string;
  /** Local commits the tracked remote branch does not have yet. */
  ahead?: number;
  remoteBranches?: string[];
  onGeneratedDescription?: () => void;
}> = ({ directory, branch, baseBranch, trackingBranch, ahead = 0, remoteBranches = [], onGeneratedDescription }) => {
  const { t: translate } = useI18n();
  // Named even when no account there can read the project, so a GitLab
  // project with a lapsed account asks for GitLab, not GitHub.
  const repositoryHost = useRepositoryHost(directory);
  // Every change-request message in this section speaks the host's wording:
  // merge requests on GitLab, pull requests elsewhere.
  const t = React.useCallback(
    (key: I18nKey, params?: I18nParams) => translate(changeRequestCopy(key, repositoryHost?.provider), params),
    [repositoryHost?.provider, translate],
  );
  const openSourceControlSettings = useOpenSourceControlSettings();
  const { sourceControl } = useRuntimeAPIs();
  const sourceControlAuthEntries = useSourceControlAuthStore((state) => state.entries);
  const { isMobile, hasTouchInput, screenWidth } = useDeviceInfo();
  const openContextSurface = useUIStore((state) => state.openContextSurface);
  const requestWalkthroughTarget = useWalkthroughStore((state) => state.requestTarget);
  // Mirrors the rail's gating: the surface is not available on mobile widths or
  // in VS Code, so neither is its entry point.
  const showWalkthroughAction = !isMobile && screenWidth >= 768 && !isVSCodeRuntime();

  const snapshotKey = React.useMemo(() => getPullRequestSnapshotKey(directory, branch), [directory, branch]);
  const initialSnapshot = React.useMemo(
    () => pullRequestDraftSnapshots.get(snapshotKey) ?? null,
    [snapshotKey]
  );
  const ensurePrStatusEntry = useGitHubPrStatusStore((state) => state.ensureEntry);
  const setPrStatusParams = useGitHubPrStatusStore((state) => state.setParams);
  const beginActiveSourceControlContextsLoad = useGitHubPrStatusStore((state) => state.beginActiveContextsLoad);
  const commitActiveSourceControlContexts = useGitHubPrStatusStore((state) => state.commitActiveContexts);
  const releaseActiveSourceControlContexts = useGitHubPrStatusStore((state) => state.releaseActiveContexts);
  const sourceControlContextsOwnerId = React.useId();
  const startPrStatusWatching = useGitHubPrStatusStore((state) => state.startWatching);
  const stopPrStatusWatching = useGitHubPrStatusStore((state) => state.stopWatching);
  const refreshPrStatus = useGitHubPrStatusStore((state) => state.refresh);

  const [title, setTitle] = React.useState(() => initialSnapshot?.title ?? branchToTitle(branch));
  const [body, setBody] = React.useState(() => initialSnapshot?.body ?? '');
  const [draft, setDraft] = React.useState(() => initialSnapshot?.draft ?? readCreateAsDraft());
  const [additionalContext, setAdditionalContext] = React.useState(() => initialSnapshot?.additionalContext ?? '');
  const [targetBaseBranch, setTargetBaseBranch] = React.useState(() => {
    const fromSnapshot = typeof initialSnapshot?.targetBaseBranch === 'string'
      ? normalizeBranchRef(initialSnapshot.targetBaseBranch)
      : '';
    if (fromSnapshot) {
      return fromSnapshot;
    }
    return normalizeBranchRef(baseBranch);
  });

  const [isGenerating, setIsGenerating] = React.useState(false);
  const [isCreating, setIsCreating] = React.useState(false);

  const [isContextOpen, setIsContextOpen] = React.useState(false);
  const binding = useRepositoryBinding(directory, sourceControl);
  const runtimeKey = binding.scope.runtimeKey;
  React.useEffect(() => {
    if (!directory) return;
    const capturedRuntimeKey = binding.scope.runtimeKey;
    const contextRequestId = beginActiveSourceControlContextsLoad(capturedRuntimeKey, directory, sourceControlContextsOwnerId);
    const activeContexts = binding.contexts.filter((context) => getSourceControlReadContextAuthState(
      sourceControlAuthEntries[getSourceControlAuthKey(context)], context,
    ).connected);
    commitActiveSourceControlContexts(capturedRuntimeKey, directory, sourceControlContextsOwnerId, contextRequestId, activeContexts);
    return () => {
      releaseActiveSourceControlContexts(capturedRuntimeKey, directory, sourceControlContextsOwnerId);
    };
  }, [beginActiveSourceControlContextsLoad, binding.contexts, binding.scope.runtimeKey, commitActiveSourceControlContexts, directory, releaseActiveSourceControlContexts, sourceControlAuthEntries, sourceControlContextsOwnerId]);
  const readContexts = binding.contexts;
  const readContext = readContexts[0] ?? null;
  const hostAuthChecked = useSourceControlAuthStore((state) => repositoryHost
    ? state.entries[getSourceControlAuthKey(repositoryHost)]?.hasChecked === true
    : false);
  const selectedRemoteName = readContext?.primaryRemote ?? null;
  const sourceControlAuthKey = React.useMemo(
    () => readContext ? getSourceControlAuthKey(readContext) : '',
    [readContext],
  );
  const sourceControlAuthEntry = useSourceControlAuthStore((state) => state.entries[sourceControlAuthKey]);
  const sourceControlAuth = readContext
    ? getSourceControlReadContextAuthState(sourceControlAuthEntry, readContext)
    : { authChecked: sourceControlAuthEntry?.hasChecked ?? false, connected: false };
  const sourceControlAuthChecked = sourceControlAuth.authChecked;
  const [capabilityReload, setCapabilityReload] = React.useState(0);
  const [capabilityState, setCapabilityState] = React.useState<
    | { key: string; status: 'loading' | 'error'; capabilities: null }
    | { key: string; status: 'ready'; capabilities: SourceControlCapabilities }
  >({ key: '', status: 'loading', capabilities: null });
  const [useDetectedUpstream, setUseDetectedUpstream] = React.useState(false);
  const { detectedUpstream, upstreamBranches } = useDetectedUpstreamRepo(
    directory,
    sourceControl,
    readContext,
  );

  React.useEffect(() => {
    if (!readContext) return;
    let cancelled = false;
    const key = getSourceControlAuthKey(readContext);
    setCapabilityState({ key, status: 'loading', capabilities: null });
    void sourceControl.capabilities(readContext)
      .then((capabilities) => {
        if (!cancelled) setCapabilityState({ key, status: 'ready', capabilities });
      })
      .catch(() => {
        if (!cancelled) setCapabilityState({ key, status: 'error', capabilities: null });
      });
    return () => {
      cancelled = true;
    };
  }, [capabilityReload, readContext, sourceControl]);

  const currentCapabilityState = capabilityState.key === sourceControlAuthKey ? capabilityState : null;
  const sourceControlCapabilities = currentCapabilityState?.status === 'ready'
    ? currentCapabilityState.capabilities
    : null;

  React.useEffect(() => {
    setUseDetectedUpstream(false);
  }, [directory]);

  const isFork = detectedUpstream !== null;
  const canShow = Boolean(directory && branch && baseBranch && (branch !== baseBranch || isFork));

  const prStatusKey = React.useMemo(
    () => readContext ? getSourceControlStatusKey(readContext, branch) : '',
    [branch, readContext],
  );
  const mutationScopeKeyRef = React.useRef(prStatusKey);
  mutationScopeKeyRef.current = prStatusKey;
  const isMutationScopeCurrent = React.useCallback((capturedRuntimeKey: string, capturedStatusKey: string) => (
    capturedRuntimeKey === getRuntimeKey() && capturedStatusKey === mutationScopeKeyRef.current
  ), []);
  const statusEntry = useGitHubPrStatusStore((state) => state.entries[prStatusKey]);
  // The open change request shown here is followed by the server, which pushes
  // its state and checks; nothing here polls.
  const followedKeys = React.useMemo(() => (prStatusKey ? [prStatusKey] : []), [prStatusKey]);
  useTrackedItems(useBranchTrackedPulls(followedKeys));

  const isLoading = statusEntry?.isLoading ?? false;
  const status = sourceControlAuth.connected ? statusEntry?.status ?? null : null;
  const error = binding.error ? t('settings.gitlab.status.operationFailed') : statusEntry?.error ?? null;
  const isInitialStatusResolved = statusEntry?.isInitialStatusResolved ?? false;

  const availableBaseBranches = React.useMemo(() => {
    const baseRemoteName = useDetectedUpstream ? null : selectedRemoteName;
    const unique = new Set<string>();

    for (const remoteBranch of remoteBranches) {
      const branchName = remoteBranchToName(remoteBranch, baseRemoteName);
      if (!branchName || branchName === 'HEAD') {
        continue;
      }
      unique.add(branchName);
    }

    // When using detected upstream, include all upstream repo branches
    if (useDetectedUpstream) {
      for (const b of upstreamBranches) {
        if (b && b !== 'HEAD') {
          unique.add(b);
        }
      }
    }

    const defaultBase = normalizeBranchRef(baseBranch);
    if (defaultBase && defaultBase !== 'HEAD') {
      unique.add(defaultBase);
    }

    const currentTarget = normalizeBranchRef(targetBaseBranch);
    if (currentTarget && currentTarget !== 'HEAD') {
      unique.add(currentTarget);
    }

    return Array.from(unique).sort((a, b) => a.localeCompare(b));
  }, [baseBranch, remoteBranches, selectedRemoteName, targetBaseBranch, upstreamBranches, useDetectedUpstream]);

  React.useEffect(() => {
    const normalizedBase = normalizeBranchRef(baseBranch);
    if (!targetBaseBranch && normalizedBase) {
      setTargetBaseBranch(normalizedBase);
      return;
    }

    if (availableBaseBranches.length === 0) {
      return;
    }

    if (!availableBaseBranches.includes(targetBaseBranch)) {
      const fallback = availableBaseBranches.includes(normalizedBase)
        ? normalizedBase
        : availableBaseBranches[0];
      if (fallback) {
        setTargetBaseBranch(fallback);
      }
    }
  }, [availableBaseBranches, baseBranch, targetBaseBranch]);

  const pendingActionRefreshTimersRef = React.useRef<number[]>([]);
  const mutationKeysRef = React.useRef(new Map<string, { key: string; inFlight: boolean }>());

  const beginMutation = React.useCallback((signature: string): string | null => {
    const existing = mutationKeysRef.current.get(signature);
    if (existing?.inFlight) return null;
    if (existing) {
      existing.inFlight = true;
      return existing.key;
    }
    const key = createMutationKey();
    mutationKeysRef.current.set(signature, { key, inFlight: true });
    return key;
  }, []);

  const finishMutation = React.useCallback((signature: string, key: string, retain: boolean) => {
    const entry = mutationKeysRef.current.get(signature);
    if (!entry || entry.key !== key) return;
    if (retain) {
      entry.inFlight = false;
    } else {
      mutationKeysRef.current.delete(signature);
    }
  }, []);

  // Auto-enable detected upstream when there's no explicit upstream remote
  React.useEffect(() => {
    if (detectedUpstream) {
      setUseDetectedUpstream(true);
    }
  }, [detectedUpstream]);

  // Set target base branch to upstream's default branch when using detected upstream
  React.useEffect(() => {
    if (useDetectedUpstream && detectedUpstream?.defaultBranch) {
      setTargetBaseBranch(detectedUpstream.defaultBranch);
    }
  }, [useDetectedUpstream, detectedUpstream?.defaultBranch]);

  const pr = status?.changeRequest ?? status?.pr ?? null;
  const statusIdentity = status?.identity ?? readContext;
  const statusProject = React.useMemo(() => status?.project ?? (status?.repo && statusIdentity
    ? { ...status.repo, ...statusIdentity, id: `${status.repo.owner}/${status.repo.repo}`, name: status.repo.repo }
    : null), [status?.project, status?.repo, statusIdentity]);
  // A closed/merged PR is the branch's history, not its live status: it still
  // deserves to be shown (you just merged it), but the branch is free again, so
  // the panel offers creating the next PR instead of a read-only detail view.
  const isHistoricalPr = pr?.state === 'merged' || pr?.state === 'closed';
  const livePr = isHistoricalPr ? null : pr;

  const checks = status?.ci?.summary ?? status?.checks ?? null;

  const [isManualRefreshing, setIsManualRefreshing] = React.useState(false);
  const manualRefreshMountedRef = React.useRef(true);
  React.useEffect(() => {
    manualRefreshMountedRef.current = true;
    return () => { manualRefreshMountedRef.current = false; };
  }, []);
  const refresh = React.useCallback(async (options?: { force?: boolean; onlyExistingPr?: boolean; silent?: boolean; markInitialResolved?: boolean }) => {
    await refreshPrStatus(prStatusKey, options);
  }, [prStatusKey, refreshPrStatus]);

  const scheduleActionRefresh = React.useCallback((capturedRuntimeKey: string, capturedStatusKey: string) => {
    pendingActionRefreshTimersRef.current.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    pendingActionRefreshTimersRef.current = PR_ACTION_REFRESH_DELAYS_MS.map((delayMs) => window.setTimeout(() => {
      if (!isMutationScopeCurrent(capturedRuntimeKey, capturedStatusKey)) return;
      void refreshPrStatus(capturedStatusKey, { force: true, silent: true, markInitialResolved: true });
    }, delayMs));
  }, [isMutationScopeCurrent, refreshPrStatus]);

  const reconcileUnknownOutcome = React.useCallback(async (
    error: Error,
    capturedRuntimeKey: string,
    capturedStatusKey: string,
  ): Promise<void> => {
    await reconcileUnknownMutationOutcome({
      error,
      isCurrent: () => isMutationScopeCurrent(capturedRuntimeKey, capturedStatusKey),
      refresh: () => refreshPrStatus(capturedStatusKey, { force: true, silent: true, markInitialResolved: true }),
      scheduleRefresh: () => scheduleActionRefresh(capturedRuntimeKey, capturedStatusKey),
    });
  }, [isMutationScopeCurrent, refreshPrStatus, scheduleActionRefresh]);

  React.useEffect(() => {
    if (!readContext || !prStatusKey) return;
    ensurePrStatusEntry(prStatusKey);
    setPrStatusParams(prStatusKey, {
      directory,
      branch,
      remoteName: readContext.primaryRemote,
      canShow,
      identity: readContext,
      readContext,
      sourceControl,
      authChecked: sourceControlAuth.authChecked,
      connected: sourceControlAuth.connected,
    });
  }, [
    branch,
    canShow,
    directory,
    ensurePrStatusEntry,
    prStatusKey,
    readContext,
    sourceControl,
    sourceControlAuth.authChecked,
    sourceControlAuth.connected,
    setPrStatusParams,
  ]);

  // A refresh often answers from the server cache within milliseconds, and a
  // spinner that never reaches the screen reads as "the button did nothing".
  const PR_MANUAL_REFRESH_MIN_SPIN_MS = 600;
  const refreshManually = React.useCallback(async () => {
    if (isManualRefreshing) return;
    setIsManualRefreshing(true);
    const startedAt = Date.now();
    try {
      await refresh({ force: true });
    } finally {
      const remaining = PR_MANUAL_REFRESH_MIN_SPIN_MS - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
      if (manualRefreshMountedRef.current) setIsManualRefreshing(false);
    }
  }, [isManualRefreshing, refresh]);

  React.useEffect(() => {
    if (!readContext || !prStatusKey) return;
    startPrStatusWatching(prStatusKey);
    return () => {
      stopPrStatusWatching(prStatusKey);
    };
  }, [prStatusKey, readContext, startPrStatusWatching, stopPrStatusWatching]);

  React.useEffect(() => {
    const snapshot = pullRequestDraftSnapshots.get(snapshotKey) ?? null;
    setTitle(snapshot?.title ?? branchToTitle(branch));
    setBody(snapshot?.body ?? '');
    setDraft(snapshot?.draft ?? readCreateAsDraft());
    setTargetBaseBranch(snapshot?.targetBaseBranch ? normalizeBranchRef(snapshot.targetBaseBranch) : normalizeBranchRef(baseBranch));
  }, [baseBranch, branch, snapshotKey]);

  React.useEffect(() => {
    if (!readContext || !prStatusKey || !sourceControlAuth.connected) return;
    void refresh({ markInitialResolved: true });
  }, [prStatusKey, readContext, refresh, sourceControlAuth.connected]);

  React.useEffect(() => {
    if (!canShow || !readContext || !sourceControlAuth.connected) {
      return;
    }
    void refresh({ force: true, silent: true, markInitialResolved: true });
  }, [canShow, readContext, refresh, sourceControlAuth.connected]);

  React.useEffect(() => {
    // Coming back to the app is the moment a PR is most likely to have changed
    // elsewhere — including a merged one being replaced by a newer open PR — so
    // staleness is read from the store when the event fires, not captured here.
    const refreshWhenStale = () => {
      const lastRefreshAt = useGitHubPrStatusStore.getState().entries[prStatusKey]?.lastRefreshAt ?? 0;
      if (Date.now() - lastRefreshAt > 60_000) {
        void refresh({ force: true, silent: true });
      }
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      refreshWhenStale();
    };

    window.addEventListener('focus', refreshWhenStale);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refreshWhenStale);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [prStatusKey, refresh]);

  React.useEffect(() => {
    if (sourceControlAuthChecked && !sourceControlAuth.connected) {
      void refresh({ force: true, silent: true, markInitialResolved: true });
    }
  }, [refresh, sourceControlAuth.connected, sourceControlAuthChecked]);

  React.useEffect(() => {
    if (!directory || !branch) {
      return;
    }
    pullRequestDraftSnapshots.set(snapshotKey, {
      title,
      body,
      draft,
      additionalContext,
      targetBaseBranch,
    });
  }, [snapshotKey, title, body, draft, additionalContext, targetBaseBranch, directory, branch]);

  React.useEffect(() => {
    return () => {
      pendingActionRefreshTimersRef.current.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      pendingActionRefreshTimersRef.current = [];
    };
  }, [prStatusKey, runtimeKey]);

  React.useEffect(() => () => {
    mutationKeysRef.current.clear();
  }, []);

  // Where the branch's own commits start. For cross-repo PRs, the upstream's
  // default branch SHA: a bare branch name like "main" would resolve to the
  // local ref, making "git log main..main" a no-op.
  const commitRangeBase = (useDetectedUpstream && detectedUpstream?.defaultBranchSha)
    ? detectedUpstream.defaultBranchSha
    : readContext
      ? `${readContext.primaryRemote}/${targetBaseBranch}`
      : targetBaseBranch;

  // A branch of one commit is titled by it, as the host does; until the
  // title is edited. More commits keep the branch name for Generate to replace.
  React.useEffect(() => {
    if (!directory || !branch || !commitRangeBase) return;
    let cancelled = false;
    void getGitLog(directory, { from: commitRangeBase, to: branch, maxCount: 2 })
      .then((log) => {
        const subject = log.all.length === 1 ? log.all[0]?.message.trim() : '';
        if (cancelled || !subject) return;
        setTitle((current) => (current === branchToTitle(branch) ? subject : current));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [branch, commitRangeBase, directory]);

  // Unpublished, or ahead of what it tracks: the remote misses commits.
  const needsPush = !trackingBranch || ahead > 0;
  const branchPush = useBranchPush(directory, branch);
  const descriptionId = React.useId();

  const chooseDraft = (next: boolean) => {
    setDraft(next);
    rememberCreateAsDraft(next);
  };

  const generateDescription = React.useCallback(async () => {
    if (isGenerating) return;
    if (!directory) return;
    setIsGenerating(true);
    try {
      const baseRef = commitRangeBase;
      const payload: { base: string; head: string; context?: string; files?: string[]; changeRequestProvider?: SourceControlProvider } = {
        base: baseRef,
        head: branch,
        ...(readContext?.provider ? { changeRequestProvider: readContext.provider } : {}),
      };
      if (additionalContext) {
        payload.context = additionalContext;
      }
      const generated = await generatePullRequestDescription(directory, payload);

      if (generated.title?.trim()) {
        setTitle(generated.title.trim());
      }
      if (generated.body?.trim()) {
        setBody(generated.body.trim());
      }
      onGeneratedDescription?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('gitView.pr.toast.generateDescriptionFailed'), { description: message });
    } finally {
      setIsGenerating(false);
    }
  }, [additionalContext, branch, commitRangeBase, directory, isGenerating, onGeneratedDescription, readContext, t]);

  const createPr = React.useCallback(async () => {
    if (sourceControlCapabilities?.changeRequests !== true) {
      toast.error(t('gitView.pr.toast.createPrFailed'), { description: t('gitView.pr.capabilitiesUnavailable') });
      return;
    }
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error(t('gitView.pr.toast.titleRequired'));
      return;
    }

    const trimmedBase = targetBaseBranch.trim();
    if (!trimmedBase) {
      toast.error(t('gitView.pr.toast.baseBranchRequired'));
      return;
    }
    if (!useDetectedUpstream && trimmedBase === branch) {
      toast.error(t('gitView.pr.toast.baseMustDifferFromHead'));
      return;
    }
    const targetProject = useDetectedUpstream ? detectedUpstream : statusProject;
    if (!readContext || !targetProject) {
      toast.error(t('gitView.pr.toast.createPrFailed'), { description: t('gitView.pr.statusUnavailable') });
      return;
    }

    // The host makes the pull request from what the remote has.
    if (needsPush) {
      setIsCreating(true);
      const pushed = await branchPush.push();
      if (!pushed) {
        setIsCreating(false);
        return;
      }
    }

    const capturedRuntimeKey = getRuntimeKey();
    const capturedStatusKey = prStatusKey;
    const target = { owner: targetProject.owner, name: targetProject.name };
    const payloadBody = body.trim() ? body : undefined;
    const remote = useDetectedUpstream ? undefined : readContext.primaryRemote;
    const headRemote = useDetectedUpstream ? readContext.primaryRemote : undefined;
    const signature = createMutationSignature(capturedRuntimeKey, readContext, [
      target.owner, target.name, branch, trimmedBase, trimmedTitle, payloadBody, draft, remote, headRemote,
    ]);
    const idempotencyKey = beginMutation(signature);
    if (!idempotencyKey) {
      setIsCreating(false);
      return;
    }
    setIsCreating(true);
    let retainMutationKey = false;
    let mutationSettled = false;
    try {
      const payload: CreateChangeRequestInput = {
        ...readContext,
        idempotencyKey,
        target: { project: target, head: branch, base: trimmedBase },
        title: trimmedTitle,
        draft,
      };
      if (payloadBody !== undefined) payload.body = payloadBody;
      if (remote) payload.remote = remote;
      if (headRemote) payload.headRemote = headRemote;
      const receipt = await sourceControl.changeRequestCreate(payload);
      mutationSettled = true;
      finishMutation(signature, idempotencyKey, false);
      if (!isMutationScopeCurrent(capturedRuntimeKey, capturedStatusKey)) return;
      toast.success(t('gitView.pr.toast.prCreated'));
      await refresh({ force: true });
      if (!isMutationScopeCurrent(capturedRuntimeKey, capturedStatusKey)) return;
      // The receipt names the number; the refreshed status has its address.
      const created = useGitHubPrStatusStore.getState().entries[capturedStatusKey]?.status;
      const createdChangeRequest = created?.changeRequest ?? created?.pr;
      if (createdChangeRequest && createdChangeRequest.number === receipt.target.number) {
        linkCreatedChangeRequestToCurrentSession(directory, createdChangeRequest);
      }
      scheduleActionRefresh(capturedRuntimeKey, capturedStatusKey);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      retainMutationKey = hasUnknownMutationOutcomeCode(error);
      const message = error.message;
      toast.error(t('gitView.pr.toast.createPrFailed'), { description: message });
      if (retainMutationKey) await reconcileUnknownOutcome(error, capturedRuntimeKey, capturedStatusKey);
    } finally {
      if (!mutationSettled) finishMutation(signature, idempotencyKey, retainMutationKey);
      setIsCreating(false);
    }
  }, [beginMutation, body, branch, branchPush, detectedUpstream, directory, draft, finishMutation, isMutationScopeCurrent, needsPush, prStatusKey, readContext, reconcileUnknownOutcome, refresh, scheduleActionRefresh, sourceControl, sourceControlCapabilities?.changeRequests, statusProject, targetBaseBranch, title, useDetectedUpstream, t]);

  const containerClassName = 'border-0 bg-transparent rounded-none px-4 py-3';

  if (!canShow) {
    return (
      <section className={containerClassName}>
        <div className="space-y-1 pt-3">
          <div className="flex items-center justify-between gap-2">
            <div className="typography-ui-header font-semibold text-foreground">
              {t('gitView.pullRequest.title')}
            </div>
            <GitHubAccountControl identity={repositoryHost ?? undefined} />
          </div>
          <div className="typography-micro text-muted-foreground">
            {t('gitView.pullRequest.availableOnFeatureBranches')}
          </div>
        </div>
      </section>
    );
  }

  // An open pull request on this branch reads as the issues and PRs board
  // shows one; creating one, and a merged or closed one, keep this form.
  // A status read back from the cache carries only the legacy PR shape; it
  // becomes a change request with the project the status names.
  const liveChangeRequest: ChangeRequest | null = status?.changeRequest && status.changeRequest.state === 'open'
    ? status.changeRequest
    : livePr && statusProject && statusIdentity
      ? {
        ...statusIdentity,
        id: `${statusProject.owner}/${statusProject.name}#${livePr.number}`,
        number: livePr.number,
        project: { ...statusIdentity, id: statusProject.id, owner: statusProject.owner, name: statusProject.name, url: statusProject.url ?? '' },
        title: livePr.title,
        body: livePr.body,
        url: livePr.url,
        state: livePr.state,
        draft: livePr.draft,
        base: livePr.base,
        head: livePr.head,
        headSha: livePr.headSha,
        mergeable: livePr.mergeable,
        mergeableState: livePr.mergeableState,
      }
      : null;
  if (liveChangeRequest && readContext) {
    return (
      <div className="h-full min-h-0">
        <BranchPullRequestPreview
          directory={directory}
          context={readContext}
          changeRequest={liveChangeRequest}
          onChanged={() => void refresh({ force: true, silent: true, markInitialResolved: true })}
        />
      </div>
    );
  }

  const originRepoUrl = statusProject?.url || null;
  const repoUrl = (useDetectedUpstream && detectedUpstream?.url) ? detectedUpstream.url : originRepoUrl;
  const capabilitiesUnavailable = currentCapabilityState?.status === 'error';
  const isConnected = Boolean(status?.connected);
  // A project on a host where no account can read it gets the same notice as
  // one whose account dropped mid-way.
  const hostUnreadable = Boolean(!readContext && repositoryHost && binding.status === 'ready' && hostAuthChecked);
  const shouldShowConnectionNotice = Boolean(statusIdentity && sourceControlAuthChecked && status?.connected === false) || hostUnreadable;
  const noticeIdentity = statusIdentity ?? repositoryHost;
  const providerName = noticeIdentity ? getSourceControlProviderLabel(noticeIdentity.provider) : null;
  const prVisualState = getPrVisualState(status);
  const prColorVar = prVisualState ? `var(--pr-${prVisualState})` : 'var(--status-info)';
  const prStateIconName = prVisualState === 'draft'
    ? 'git-pr-draft'
    : prVisualState === 'merged'
      ? 'git-merge'
      : prVisualState === 'closed'
        ? 'git-close-pull-request'
        : 'git-pull-request';
  const prStatusText = pr
    ? [
        `${pr.state}${pr.draft ? ' (draft)' : ''}`,
        // Whether it can merge is a question for an open one only: GitLab reports
        // a merged or closed merge request as not mergeable.
        pr.state === 'open' && pr.mergeable === false ? t('gitView.pr.notMergeable') : null,
        pr.state === 'open' && typeof pr.mergeableState === 'string' && pr.mergeableState && pr.mergeableState !== 'unknown'
          ? pr.mergeableState
          : null,
      ].filter(Boolean).join(' · ')
    : '';
  const checksText = checks
    ? checks.total > 0
      ? `${checks.success}/${checks.total} ${t('gitView.pr.checks.label')}`
      : `${checks.state} ${t('gitView.pr.checks.label')}`
    : '';
  const headerClassName = 'px-0 py-3 border-b border-border/40 flex flex-col gap-1';
  const bodyClassName = 'flex flex-col gap-3 py-3';

  const refreshButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 px-0"
          disabled={isLoading || isManualRefreshing}
          onClick={() => void refreshManually()}
          aria-label={t('gitView.pr.actions.refreshAria')}
        >
          <Icon name={isLoading || isManualRefreshing ? 'loader-4' : 'refresh'} className={cn('size-4 text-muted-foreground', (isLoading || isManualRefreshing) && 'animate-spin')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent><p>{t('gitView.pr.actions.refresh')}</p></TooltipContent>
    </Tooltip>
  );
  const notesShown = isContextOpen || additionalContext.trim().length > 0;
  const unpushedNotice = !needsPush
    ? null
    : !trackingBranch
      ? t('gitView.pr.unpushed.unpublished')
      : ahead === 1
        ? t('gitView.pr.unpushed.one')
        : t('gitView.pr.unpushed.many', { count: ahead });
  const createLabel = needsPush
    ? t(draft ? 'gitView.pr.actions.pushAndCreateDraftPr' : 'gitView.pr.actions.pushAndCreatePr')
    : t(draft ? 'gitView.pr.actions.createDraftPr' : 'gitView.pr.actions.createPr');
  const createDisabled = isCreating || !isConnected || sourceControlCapabilities?.changeRequests !== true
    || !targetBaseBranch.trim() || (!useDetectedUpstream && targetBaseBranch.trim() === branch);

  return (
    <section className={containerClassName}>
      {/* A merged or closed PR keeps its header; creating one needs none. */}
      {pr ? <div className={headerClassName}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="shrink-0"
              onClick={() => void openExternal(pr.url)}
              aria-label={providerName
                ? t('gitView.pr.actions.openOnProviderAria', { provider: providerName })
                : t('gitView.header.openPullRequest')}
            >
              <Icon name={prStateIconName} className="size-4 shrink-0" style={{ color: prColorVar }} />
              {providerName
                ? t('gitView.pr.actions.openOnProvider', { provider: providerName })
                : t('gitView.header.openPullRequest')}
            </Button>
            <h3 className="typography-ui-header font-semibold text-foreground truncate">{t('gitView.pullRequest.title')}</h3>
            <span className="typography-meta text-muted-foreground truncate">{formatChangeRequestReference(statusIdentity?.provider, pr.number)}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">{refreshButton}</div>
        </div>

        <div className="@container/pr-actions flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 typography-micro text-muted-foreground">
            <span style={{ color: prColorVar }}>{prStatusText}</span>
            {checks ? (
              <span className="inline-flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${statusColor(checks.state)}`} />
                {checksText}
              </span>
            ) : null}
            {trackingBranch && selectedRemoteName && trackingBranch.split('/')[0] !== selectedRemoteName ? (
              <span className="min-w-0 truncate">
                {trackingBranch.split('/')[0]} → {selectedRemoteName}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {showWalkthroughAction && (readContext?.provider === 'github' || readContext?.provider === 'gitlab') ? (
              <Button
                variant="outline"
                size="sm"
                className={cn('pr-actions__walkthrough-button h-7 shrink-0 gap-1.5 px-2', WALKTHROUGH_ACTION_CLASS)}
                onClick={() => {
                  requestWalkthroughTarget(directory, {
                    source: {
                      kind: 'pr',
                      number: pr.number,
                      ...(statusProject ? { sourceRepo: { owner: statusProject.owner, repo: statusProject.name } } : {}),
                    },
                    context: readContext,
                  });
                  openContextSurface(directory, 'walkthrough');
                }}
                aria-label={t('walkthrough.action.open')}
              >
                <Icon name="route" className="size-4" />
                <span className="pr-actions__walkthrough-label typography-ui-label">
                  {t('walkthrough.action.open')}
                </span>
              </Button>
            ) : null}
          </div>
        </div>
      </div> : null}

      <div className={bodyClassName}>
        {capabilitiesUnavailable ? (
          <div className="space-y-2 rounded-md border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3">
            <div className="typography-ui-label text-[var(--status-error)]">{t('gitView.pr.capabilitiesUnavailable')}</div>
            <Button variant="outline" size="sm" onClick={() => setCapabilityReload((value) => value + 1)}>
              {t('settings.sourceControl.transport.retry')}
            </Button>
          </div>
        ) : null}
        {shouldShowConnectionNotice && providerName ? (
          <div className="space-y-2">
              <div className="typography-meta text-muted-foreground">
              {t('gitView.pr.providerNotConnected', { provider: providerName })}
            </div>
                <Button variant="outline" size="sm" onClick={openSourceControlSettings} className="w-fit">
                  {t('gitView.pr.actions.openSettings')}
                </Button>
              </div>
            ) : null}

            {error ? (
              <div className="space-y-2">
                <div className="typography-ui-label text-foreground">{t('gitView.pr.statusUnavailable')}</div>
                <div className="typography-meta text-muted-foreground break-words">{error}</div>
                {binding.error ? <Button variant="outline" size="sm" onClick={() => void binding.retry()} disabled={binding.status === 'loading'}>
                  {t('settings.sourceControl.transport.retry')}
                </Button> : null}
                {repoUrl ? (
                  <Button variant="outline" size="sm" asChild className="w-fit">
                    <a href={repoUrl} target="_blank" rel="noopener noreferrer">
                      <Icon name="external-link" className="size-4" />
                      {t('gitView.pr.actions.repo')}
                    </a>
                  </Button>
                ) : null}
              </div>
            ) : null}

            {(livePr || (!pr && !isInitialStatusResolved)) && !error && !shouldShowConnectionNotice && (binding.status === 'loading' || readContext) ? (
              <div className="flex items-center gap-2 typography-micro text-muted-foreground">
                <Icon name="loader-4" className="size-4 animate-spin" />
                {t('gitView.pr.checkingStatus')}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {pr && isHistoricalPr ? (
                  <div className="flex min-w-0 items-center gap-2 rounded-md border border-border/60 bg-surface-muted/40 px-2.5 py-2">
                    <Icon
                      name={pr.state === 'merged' ? 'git-merge' : 'git-close-pull-request'}
                      className="size-4 shrink-0"
                      style={{ color: prColorVar }}
                    />
                    <div className="min-w-0 flex-1 typography-micro text-muted-foreground">
                      {pr.state === 'merged'
                        ? t('gitView.pr.history.merged', { number: pr.number, base: pr.base || targetBaseBranch })
                        : t('gitView.pr.history.closed', { number: pr.number })}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="shrink-0"
                      onClick={() => void openExternal(pr.url)}
                      aria-label={t('gitView.pr.actions.openOnProviderAria', { provider: providerName })}
                    >
                      <Icon name="external-link" className="size-3.5" />
                    </Button>
                  </div>
                ) : null}
                {/* Where it goes: this branch into the base, picked in place. */}
                <div className="flex min-w-0 items-center gap-1.5">
                  <Icon name="git-pull-request" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate typography-ui-label text-foreground" title={branch}>{branch}</span>
                  <Icon name="arrow-right" className="size-3.5 shrink-0 text-muted-foreground" />
                  {useDetectedUpstream && detectedUpstream ? (
                    <span className="min-w-0 shrink truncate typography-meta text-muted-foreground">{detectedUpstream.owner}/{detectedUpstream.name}</span>
                  ) : null}
                  {availableBaseBranches.length > 0 ? (
                    <Select value={targetBaseBranch} onValueChange={setTargetBaseBranch}>
                      <SelectTrigger size="sm" className="w-auto min-w-0" aria-label={t('gitView.pr.field.baseBranch')}>
                        <SelectValue placeholder={t('gitView.pr.placeholder.selectBaseBranch')} />
                      </SelectTrigger>
                      <SelectContent>
                        {availableBaseBranches.map((candidate) => (
                          <SelectItem key={candidate} value={candidate}>{candidate}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      value={targetBaseBranch}
                      onChange={(e) => setTargetBaseBranch(e.target.value)}
                      placeholder={t('gitView.pr.placeholder.main')}
                      aria-label={t('gitView.pr.field.baseBranch')}
                      className="h-7 w-32"
                    />
                  )}
                  <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    {repoUrl ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-7 w-7 px-0" asChild>
                            <a href={repoUrl} target="_blank" rel="noopener noreferrer" aria-label={t('gitView.pr.actions.repo')}>
                              <Icon name="external-link" className="size-4 text-muted-foreground" />
                            </a>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent><p>{t('gitView.pr.actions.repo')}</p></TooltipContent>
                      </Tooltip>
                    ) : null}
                    {refreshButton}
                  </div>
                </div>

                <label className="space-y-1">
                  <div className="typography-micro text-muted-foreground">{t('gitView.pr.field.title')}</div>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={t('gitView.pr.placeholder.title')}
                    autoCorrect={hasTouchInput ? "on" : "off"}
                    autoCapitalize={hasTouchInput ? "sentences" : "off"}
                    spellCheck={hasTouchInput}
                  />
                </label>

                <div className="space-y-1">
                  {/* Generate writes the title and this description, so it sits on it. */}
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor={descriptionId} className="typography-micro text-muted-foreground">{t('gitView.pr.field.description')}</label>
                    <div className="flex items-center">
                      <Button
                        variant="ghost"
                        size="xs"
                        className="rounded-r-none supports-[corner-shape:squircle]:rounded-r-none"
                        onClick={generateDescription}
                        disabled={isGenerating || isCreating}
                      >
                        {isGenerating ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : <Icon name="ai-generate-2" className="size-3.5 text-primary" />}
                        {t('gitView.commit.generate')}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="xs"
                            className="rounded-l-none border-l-0 supports-[corner-shape:squircle]:rounded-l-none px-1"
                            disabled={isGenerating || isCreating}
                            aria-label={t('gitView.pr.generate.optionsAria')}
                          >
                            <Icon name="arrow-down-s" className="size-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-60">
                          <DropdownMenuItem onSelect={() => setIsContextOpen(true)}>
                            <Icon name="sticky-note" className="size-4 shrink-0" />
                            {t('gitView.pr.generate.withNotes')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                  {/* Notes only the generator reads; they stay while they hold text. */}
                  {notesShown ? (
                    <div className="relative">
                      <Textarea
                        value={additionalContext}
                        onChange={(e) => setAdditionalContext(e.target.value)}
                        className="min-h-[72px] pr-9"
                        placeholder={t('gitView.pr.placeholder.additionalContext')}
                        aria-label={t('gitView.pr.generate.notesAria')}
                        autoFocus={isContextOpen && !additionalContext}
                      />
                      <Button
                        variant="ghost"
                        size="xs"
                        className="absolute right-1.5 top-1.5 h-6 w-6 px-0"
                        onClick={() => {
                          setAdditionalContext('');
                          setIsContextOpen(false);
                        }}
                        aria-label={t('gitView.pr.generate.removeNotesAria')}
                      >
                        <Icon name="close" className="size-3.5" />
                      </Button>
                    </div>
                  ) : null}
                  <Textarea
                    id={descriptionId}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    className="min-h-[140px]"
                    placeholder={t('gitView.pr.placeholder.whatChanged')}
                    autoCorrect={hasTouchInput ? "on" : "off"}
                    autoCapitalize={hasTouchInput ? "sentences" : "off"}
                    spellCheck={hasTouchInput}
                  />
                </div>

                {/* The pull request is made from what the remote has: anything
                    still local goes up first, as part of the same action. */}
                {unpushedNotice ? (
                  <div className="flex items-center gap-1.5 typography-micro text-[var(--status-warning)]">
                    <Icon name="arrow-up" className="size-3.5 shrink-0" />
                    {unpushedNotice}
                  </div>
                ) : null}
                <div className="flex justify-end">
                  <div className="flex items-center">
                    <Button
                      size="sm"
                      className="justify-center gap-2 rounded-r-none supports-[corner-shape:squircle]:rounded-r-none"
                      onClick={createPr}
                      disabled={createDisabled}
                    >
                      {isCreating ? <Icon name="loader-4" className="size-4 animate-spin" /> : <Icon name={draft ? 'git-pr-draft' : 'git-pull-request'} className="size-4" />}
                      <span>{createLabel}</span>
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          className="rounded-l-none border-l-0 supports-[corner-shape:squircle]:rounded-l-none px-1.5"
                          disabled={isCreating}
                          aria-label={t('gitView.pr.createKindAria')}
                        >
                          <Icon name="arrow-down-s" className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuRadioGroup value={draft ? 'draft' : 'ready'} onValueChange={(value) => chooseDraft(value === 'draft')}>
                          <DropdownMenuRadioItem value="ready">{t('gitView.pr.actions.createPr')}</DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value="draft">{t('gitView.pr.actions.createDraftPr')}</DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                {branchPush.dialogs}
              </div>
            )}
      </div>

    </section>
  );
};
