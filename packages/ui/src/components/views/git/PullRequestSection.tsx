import React from 'react';
import {
  RiChat4Line,
  RiCheckLine,
  RiCheckboxCircleLine,
  RiAiGenerate2,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiCheckboxBlankLine,
  RiCheckboxLine,
  RiCloseLine,
  RiEditLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiGitClosePullRequestLine,
  RiGitMergeLine,
  RiGitPrDraftLine,
  RiGitPullRequestLine,
  RiInformationLine,
  RiLoader4Line,
} from '@remixicon/react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { generatePullRequestDescription } from '@/lib/gitApi';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDeviceInfo } from '@/lib/device';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageStore } from '@/stores/messageStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import type {
  GitHubPullRequest,
  GitHubCheckRun,
  GitHubPullRequestContextResult,
  GitHubPullRequestStatus,
  GitRemote,
} from '@/lib/api/types';

type MergeMethod = 'merge' | 'squash' | 'rebase';

const PR_REVALIDATE_TTL_MS = 90_000;
const PR_REVALIDATE_INTERVAL_MS = 30_000;
const PR_DISCOVERY_INTERVAL_MS = 5 * 60_000;

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

const getPrVisualState = (status: GitHubPullRequestStatus | null): 'draft' | 'open' | 'blocked' | 'merged' | 'closed' | null => {
  const pr = status?.pr;
  if (!pr) {
    return null;
  }
  if (pr.state === 'merged') {
    return 'merged';
  }
  if (pr.state === 'closed') {
    return 'closed';
  }
  if (pr.draft) {
    return 'draft';
  }
  const checksFailed = status?.checks?.state === 'failure';
  const notMergeable = status?.canMerge === false || pr.mergeable === false;
  if (checksFailed || notMergeable) {
    return 'blocked';
  }
  return 'open';
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
  selectedRemoteName?: string;
};

const getTrackingRemoteName = (trackingBranch: string | null | undefined): string => {
  const normalized = String(trackingBranch || '').trim();
  if (!normalized) {
    return '';
  }

  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0) {
    return '';
  }

  return normalized.slice(0, slashIndex).trim();
};

const pickInitialPrRemote = (
  remotes: GitRemote[],
  options: { selectedRemoteName?: string; trackingBranch?: string }
): GitRemote | null => {
  if (remotes.length === 0) {
    return null;
  }

  const selectedRemoteName = String(options.selectedRemoteName || '').trim();
  if (selectedRemoteName) {
    const fromSnapshot = remotes.find((remote) => remote.name === selectedRemoteName);
    if (fromSnapshot) {
      return fromSnapshot;
    }
  }

  const trackingRemoteName = getTrackingRemoteName(options.trackingBranch);
  if (trackingRemoteName) {
    const maybeUpstream =
      trackingRemoteName === 'origin'
        ? remotes.find((remote) => remote.name === 'upstream')
        : null;
    if (maybeUpstream) {
      return maybeUpstream;
    }

    const fromTracking = remotes.find((remote) => remote.name === trackingRemoteName);
    if (fromTracking) {
      return fromTracking;
    }
  }

  const originRemote = remotes.find((remote) => remote.name === 'origin');
  if (originRemote) {
    return originRemote;
  }

  return remotes[0] ?? null;
};

type TimelineCommentItem = {
  id: string;
  body: string;
  authorName: string;
  authorLogin: string | null;
  avatarUrl: string | null;
  createdAt?: string;
  context: string;
  path: string | null;
  line: number | null;
};

type ChatDispatchTarget = {
  sessionId: string;
  providerID: string;
  modelID: string;
  currentAgentName: string | null;
  currentVariant: string | null;
};

const pullRequestDraftSnapshots = new Map<string, PullRequestDraftSnapshot>();
const pullRequestStatusSnapshots = new Map<string, GitHubPullRequestStatus>();

type TauriShell = {
  shell?: {
    open?: (url: string) => Promise<unknown>;
  };
};

const openExternal = async (url: string) => {
  if (typeof window === 'undefined') return;

  const tauri = (window as unknown as { __TAURI__?: TauriShell }).__TAURI__;
  if (tauri?.shell?.open) {
    try {
      await tauri.shell.open(url);
      return;
    } catch {
      // fall through
    }
  }

  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    // ignore
  }
};

export const PullRequestSection: React.FC<{
  directory: string;
  branch: string;
  baseBranch: string;
  trackingBranch?: string;
  remotes?: GitRemote[];
  remoteBranches?: string[];
  variant?: 'framed' | 'plain';
  onGeneratedDescription?: () => void;
}> = ({ directory, branch, baseBranch, trackingBranch, remotes = [], remoteBranches = [], variant = 'framed', onGeneratedDescription }) => {
  const { github } = useRuntimeAPIs();
  const githubAuthStatus = useGitHubAuthStore((state) => state.status);
  const githubAuthChecked = useGitHubAuthStore((state) => state.hasChecked);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const { isMobile, hasTouchInput } = useDeviceInfo();

  const openGitHubSettings = React.useCallback(() => {
    setSettingsPage('github');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage]);

  const snapshotKey = React.useMemo(() => getPullRequestSnapshotKey(directory, branch), [directory, branch]);
  const initialSnapshot = React.useMemo(
    () => pullRequestDraftSnapshots.get(snapshotKey) ?? null,
    [snapshotKey]
  );
  const initialStatusSnapshot = React.useMemo(
    () => pullRequestStatusSnapshots.get(snapshotKey) ?? null,
    [snapshotKey]
  );

  const [isLoading, setIsLoading] = React.useState(false);
  const [status, setStatus] = React.useState<GitHubPullRequestStatus | null>(() => initialStatusSnapshot);
  const [error, setError] = React.useState<string | null>(null);
  const [isInitialStatusResolved, setIsInitialStatusResolved] = React.useState(() => Boolean(initialStatusSnapshot));

  const [title, setTitle] = React.useState(() => initialSnapshot?.title ?? branchToTitle(branch));
  const [body, setBody] = React.useState(() => initialSnapshot?.body ?? '');
  const [draft, setDraft] = React.useState(() => initialSnapshot?.draft ?? false);
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
  const [mergeMethod, setMergeMethod] = React.useState<MergeMethod>('squash');

  const [isGenerating, setIsGenerating] = React.useState(false);
  const [isCreating, setIsCreating] = React.useState(false);
  const [isUpdating, setIsUpdating] = React.useState(false);
  const [isMerging, setIsMerging] = React.useState(false);
  const [isMarkingReady, setIsMarkingReady] = React.useState(false);
  const [isEditingPr, setIsEditingPr] = React.useState(false);
  const [hydratingPrBodyKey, setHydratingPrBodyKey] = React.useState<string | null>(null);
  const [editTitle, setEditTitle] = React.useState('');
  const [editBody, setEditBody] = React.useState('');

  const [isContextOpen, setIsContextOpen] = React.useState(false);
  const [isContextSheetOpen, setIsContextSheetOpen] = React.useState(false);
  const [selectedRemote, setSelectedRemote] = React.useState<GitRemote | null>(() =>
    pickInitialPrRemote(remotes, {
      selectedRemoteName: initialSnapshot?.selectedRemoteName,
      trackingBranch,
    })
  );

  const availableBaseBranches = React.useMemo(() => {
    const selectedRemoteName = selectedRemote?.name?.trim() || null;
    const unique = new Set<string>();

    for (const remoteBranch of remoteBranches) {
      const branchName = remoteBranchToName(remoteBranch, selectedRemoteName);
      if (!branchName || branchName === 'HEAD') {
        continue;
      }
      unique.add(branchName);
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
  }, [baseBranch, remoteBranches, selectedRemote?.name, targetBaseBranch]);

  const hasMultipleRemotes = remotes.length > 1;

  // Update selected remote when remotes change
  React.useEffect(() => {
    if (remotes.length === 0) {
      if (selectedRemote) {
        setSelectedRemote(null);
      }
      return;
    }

    if (!selectedRemote || !remotes.some((remote) => remote.name === selectedRemote.name)) {
      setSelectedRemote(
        pickInitialPrRemote(remotes, {
          selectedRemoteName: initialSnapshot?.selectedRemoteName,
          trackingBranch,
        })
      );
    }
  }, [initialSnapshot?.selectedRemoteName, remotes, selectedRemote, trackingBranch]);

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

  const [checksDialogOpen, setChecksDialogOpen] = React.useState(false);
  const [checkDetails, setCheckDetails] = React.useState<GitHubPullRequestContextResult | null>(null);
  const [isLoadingCheckDetails, setIsLoadingCheckDetails] = React.useState(false);
  const [expandedCheckStepKeys, setExpandedCheckStepKeys] = React.useState<Set<string>>(new Set());
  const [commentsDialogOpen, setCommentsDialogOpen] = React.useState(false);
  const [commentsDetails, setCommentsDetails] = React.useState<GitHubPullRequestContextResult | null>(null);
  const [isLoadingCommentsDetails, setIsLoadingCommentsDetails] = React.useState(false);

  const isRefreshInFlightRef = React.useRef(false);
  const lastRefreshAtRef = React.useRef(0);
  const lastDiscoveryPollAtRef = React.useRef(0);
  const statusRef = React.useRef<GitHubPullRequestStatus | null>(null);
  const attemptedBodyHydrationRef = React.useRef<Set<string>>(new Set());
  const lastSyncedPrNumberRef = React.useRef<number | null>(null);

  const canShow = Boolean(directory && branch && baseBranch && branch !== baseBranch);

  const pr = status?.pr ?? null;
  const currentPrBodyHydrationKey = pr ? `${directory}#${pr.number}` : null;
  const isHydratingCurrentPrBody = Boolean(
    currentPrBodyHydrationKey && hydratingPrBodyKey === currentPrBodyHydrationKey,
  );

  React.useEffect(() => {
    if (!github?.prContext || !pr) {
      return;
    }

    if (typeof pr.body === 'string' && pr.body.length > 0) {
      return;
    }

    const hydrationKey = `${directory}#${pr.number}`;
    if (attemptedBodyHydrationRef.current.has(hydrationKey)) {
      return;
    }
    attemptedBodyHydrationRef.current.add(hydrationKey);
    setHydratingPrBodyKey(hydrationKey);

    let cancelled = false;
    void github.prContext(directory, pr.number, { includeDiff: false, includeCheckDetails: false })
      .then((ctx) => {
        if (cancelled) {
          return;
        }
        const ctxPr = ctx?.pr;
        if (!ctxPr) {
          return;
        }
        setStatus((prev) => {
          if (!prev?.pr || prev.pr.number !== pr.number) {
            return prev;
          }
          return {
            ...prev,
            pr: {
              ...prev.pr,
              body: ctxPr.body || '',
            },
          };
        });
      })
      .catch(() => {})
      .finally(() => {
        if (cancelled) {
          return;
        }
        setHydratingPrBodyKey((prev) => (prev === hydrationKey ? null : prev));
      });

    return () => {
      cancelled = true;
    };
  }, [directory, github, pr]);

  React.useEffect(() => {
    if (!pr) {
      setIsEditingPr(false);
      setEditTitle('');
      setEditBody('');
      lastSyncedPrNumberRef.current = null;
      return;
    }

    const numberChanged =
      lastSyncedPrNumberRef.current !== null && lastSyncedPrNumberRef.current !== pr.number;

    if (numberChanged) {
      setIsEditingPr(false);
    }

    if (!isEditingPr || numberChanged) {
      setEditTitle(pr.title || '');
      setEditBody(pr.body || '');
    }

    lastSyncedPrNumberRef.current = pr.number;
  }, [isEditingPr, pr]);

  const openChecksDialog = React.useCallback(async () => {
    if (!github?.prContext) {
      toast.error('GitHub runtime API unavailable');
      return;
    }
    if (!pr) return;

    setChecksDialogOpen(true);
    setExpandedCheckStepKeys(new Set());
    setIsLoadingCheckDetails(true);
    try {
      const ctx = await github.prContext(directory, pr.number, {
        includeDiff: false,
        includeCheckDetails: true,
      });
      setCheckDetails(ctx);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Failed to load check details', { description: message });
    } finally {
      setIsLoadingCheckDetails(false);
    }
  }, [directory, github, pr]);

  const openCommentsDialog = React.useCallback(async () => {
    if (!github?.prContext) {
      toast.error('GitHub runtime API unavailable');
      return;
    }
    if (!pr) return;

    setCommentsDialogOpen(true);
    setIsLoadingCommentsDetails(true);
    try {
      const ctx = await github.prContext(directory, pr.number, {
        includeDiff: false,
        includeCheckDetails: false,
      });
      setCommentsDetails(ctx);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Failed to load comments', { description: message });
    } finally {
      setIsLoadingCommentsDetails(false);
    }
  }, [directory, github, pr]);

  const formatTimestamp = React.useCallback((value?: string) => {
    if (!value) return '';
    const ts = Date.parse(value);
    if (!Number.isFinite(ts)) {
      return value;
    }
    return new Date(ts).toLocaleString();
  }, []);

  const connectedGitHubLogin = React.useMemo(() => {
    const login = githubAuthStatus?.user?.login;
    return typeof login === 'string' ? login.trim() : '';
  }, [githubAuthStatus]);

  const selfMentionHighlightClass = React.useMemo(() => {
    return "[&_a[href*='oc-self-mention=1']]:!text-[var(--primary-base)] [&_a[href*='oc-self-mention=1']]:font-semibold [&_a[href*='oc-self-mention=1']]:!no-underline [&_a[href*='oc-self-mention=1']:hover]:!text-[var(--primary-hover)]";
  }, []);

  const linkifyMentionsMarkdown = React.useCallback((content: string) => {
    const selfLoginLower = connectedGitHubLogin.toLowerCase();
    const mentionRegex = /(^|[^\w`])@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}))/g;
    return content.replace(mentionRegex, (_match, prefix: string, username: string) => {
      const mention = `@${username}`;
      const usernameLower = username.toLowerCase();
      const selfTag = selfLoginLower && usernameLower === selfLoginLower ? '?oc-self-mention=1' : '';
      return `${prefix}[${mention}](https://github.com/${usernameLower}${selfTag})`;
    });
  }, [connectedGitHubLogin]);

  const timelineComments = React.useMemo<TimelineCommentItem[]>(() => {
    const issue = (commentsDetails?.issueComments ?? []).map((comment) => ({
      id: `issue-${comment.id}`,
      body: comment.body || '',
      authorName: comment.author?.name || comment.author?.login || 'Unknown author',
      authorLogin: comment.author?.login || null,
      avatarUrl: comment.author?.avatarUrl || null,
      createdAt: comment.createdAt,
      context: 'General comment',
      path: null as string | null,
      line: null as number | null,
    }));

    const review = (commentsDetails?.reviewComments ?? []).map((comment) => ({
      id: `review-${comment.id}`,
      body: comment.body || '',
      authorName: comment.author?.name || comment.author?.login || 'Unknown author',
      authorLogin: comment.author?.login || null,
      avatarUrl: comment.author?.avatarUrl || null,
      createdAt: comment.createdAt,
      context: 'Code review comment',
      path: comment.path || null,
      line: comment.line ?? null,
    }));

    const all = [...issue, ...review];
    all.sort((a, b) => {
      const aTs = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bTs = b.createdAt ? Date.parse(b.createdAt) : 0;
      const aVal = Number.isFinite(aTs) ? aTs : 0;
      const bVal = Number.isFinite(bTs) ? bTs : 0;
      return aVal - bVal;
    });
    return all;
  }, [commentsDetails]);

  const resolveChatDispatchTarget = React.useCallback((): ChatDispatchTarget | null => {
    if (!currentSessionId) {
      toast.error('No active session', { description: 'Open a chat session first.' });
      return null;
    }

    const { currentProviderId, currentModelId, currentAgentName, currentVariant } = useConfigStore.getState();
    const lastUsedProvider = useMessageStore.getState().lastUsedProvider;
    const providerID = currentProviderId || lastUsedProvider?.providerID;
    const modelID = currentModelId || lastUsedProvider?.modelID;
    if (!providerID || !modelID) {
      toast.error('No model selected');
      return null;
    }

    return {
      sessionId: currentSessionId,
      providerID,
      modelID,
      currentAgentName: currentAgentName ?? null,
      currentVariant: currentVariant ?? null,
    };
  }, [currentSessionId]);

  const dispatchSyntheticPrompt = React.useCallback((
    target: ChatDispatchTarget,
    visibleText: string,
    instructionsText: string,
    payloadText: string,
  ) => {
    void useMessageStore.getState().sendMessage(
      visibleText,
      target.providerID,
      target.modelID,
      target.currentAgentName ?? undefined,
      target.sessionId,
      undefined,
      null,
      [
        { text: instructionsText, synthetic: true },
        { text: payloadText, synthetic: true },
      ],
      target.currentVariant ?? undefined,
    ).catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Failed to send message', { description: message });
    });
  }, []);

  const renderCheckRunSummary = React.useCallback((run: GitHubCheckRun) => {
    const status = run.status || 'unknown';
    const conclusion = run.conclusion ?? undefined;
    const statusText = conclusion ? `${status} / ${conclusion}` : status;
    const appName = run.app?.name || run.app?.slug;
    return (
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="typography-ui-label text-foreground truncate">{run.name}</div>
            <div className="typography-micro text-muted-foreground truncate">
              {appName ? `${appName} · ${statusText}` : statusText}
            </div>
          </div>

          {run.detailsUrl ? (
            <Button variant="outline" size="sm" asChild className="flex-shrink-0">
              <a href={run.detailsUrl} target="_blank" rel="noopener noreferrer">
                <RiExternalLinkLine className="size-4" />
                Open
              </a>
            </Button>
          ) : null}
        </div>

        {run.output?.title ? (
          <div className="typography-micro text-foreground">{run.output.title}</div>
        ) : null}
        {run.output?.summary ? (
          <div className="typography-micro text-muted-foreground whitespace-pre-wrap">
            {run.output.summary}
          </div>
        ) : null}
        {run.output?.text ? (
          <div className="rounded border border-border/40 bg-background/40 px-2 py-2 typography-micro text-muted-foreground whitespace-pre-wrap max-h-48 overflow-y-auto">
            {run.output.text}
          </div>
        ) : null}

        {Array.isArray(run.annotations) && run.annotations.length > 0 ? (
          <div className="space-y-1">
            <div className="typography-micro text-muted-foreground">
              Failed annotations{run.annotations.length > 20 ? ` (showing 20/${run.annotations.length})` : ''}
            </div>
            <div className="space-y-1">
              {run.annotations.slice(0, 20).map((annotation, idx) => (
                <div key={`${annotation.path || 'file'}:${annotation.startLine || idx}:${idx}`} className="rounded border border-[var(--status-error-border)] bg-[var(--status-error-background)]/40 px-2 py-2">
                  <div className="typography-micro text-[var(--status-error)]">
                    {annotation.title || annotation.level || 'Issue'}
                    {annotation.path ? ` · ${annotation.path}` : ''}
                    {typeof annotation.startLine === 'number' ? `:${annotation.startLine}` : ''}
                    {typeof annotation.endLine === 'number' && annotation.endLine !== annotation.startLine ? `-${annotation.endLine}` : ''}
                  </div>
                  <div className="typography-micro text-foreground whitespace-pre-wrap mt-1">
                    {annotation.message}
                  </div>
                  {annotation.rawDetails ? (
                    <div className="typography-micro text-muted-foreground whitespace-pre-wrap mt-1">
                      {annotation.rawDetails}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {run.job?.steps && run.job.steps.length > 0 ? (
          <div className="space-y-1">
            <div className="typography-micro text-muted-foreground">Steps</div>
            <div className="space-y-1">
              {run.job.steps.map((step, idx) => {
                const c = (step.conclusion || '').toLowerCase();
                const isFail = c && !['success', 'neutral', 'skipped'].includes(c);
                const stepKey = `${run.id ?? 'run'}:${run.job?.jobId ?? 'job'}:${step.number ?? idx}:${step.name}`;
                const stepExpanded = expandedCheckStepKeys.has(stepKey);
                if (!isFail) {
                  return (
                    <div
                      key={stepKey}
                      className="typography-micro flex w-full items-center gap-2 rounded px-2 py-1 text-muted-foreground"
                    >
                      <span className="truncate">{step.name}</span>
                      {step.conclusion ? <span className="ml-auto flex-shrink-0">{step.conclusion}</span> : null}
                    </div>
                  );
                }
                return (
                  <Collapsible key={stepKey} open={stepExpanded}>
                    <button
                      type="button"
                      onClick={() => {
                        setExpandedCheckStepKeys((prev) => {
                          const next = new Set(prev);
                          if (next.has(stepKey)) {
                            next.delete(stepKey);
                          } else {
                            next.add(stepKey);
                          }
                          return next;
                        });
                      }}
                      className={
                        'typography-micro flex w-full items-center gap-2 rounded px-2 py-1 text-left ' +
                        (isFail ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground')
                      }
                    >
                      {stepExpanded ? <RiArrowDownSLine className="size-4" /> : <RiArrowRightSLine className="size-4" />}
                      <span className="truncate">{step.name}</span>
                      {step.conclusion ? <span className="ml-auto flex-shrink-0">{step.conclusion}</span> : null}
                    </button>
                    <CollapsibleContent>
                      <div className="ml-6 mt-1 rounded border border-border/40 bg-background/40 px-2 py-2 typography-micro text-muted-foreground space-y-1">
                        {typeof step.number === 'number' ? <div>Step: {step.number}</div> : null}
                        {step.status ? <div>Status: {step.status}</div> : null}
                        {step.conclusion ? <div>Conclusion: {step.conclusion}</div> : null}
                        {step.startedAt ? <div>Started: {formatTimestamp(step.startedAt)}</div> : null}
                        {step.completedAt ? <div>Completed: {formatTimestamp(step.completedAt)}</div> : null}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    );
  }, [expandedCheckStepKeys, formatTimestamp]);

  const sendFailedChecksToChat = React.useCallback(async () => {
    setActiveMainTab('chat');

    if (!github?.prContext) {
      toast.error('GitHub runtime API unavailable');
      return;
    }
    if (!directory || !pr) return;
    const target = resolveChatDispatchTarget();
    if (!target) {
      return;
    }

    try {
      const context = await github.prContext(directory, pr.number, { includeDiff: false, includeCheckDetails: true });
      const runs = context.checkRuns ?? [];
      const failed = runs.filter((r) => {
        const conclusion = typeof r.conclusion === 'string' ? r.conclusion.toLowerCase() : '';
        if (!conclusion) return false;
        return !['success', 'neutral', 'skipped'].includes(conclusion);
      });

      if (failed.length === 0) {
        toast.message('No failed checks');
        return;
      }

      const visibleText = 'Review these PR failed checks and propose likely fixes. Do not implement until I confirm.';
      const instructionsText = `Use the attached checks payload.
- Summarize what is failing.
- Prioritize check annotations/errors over generic status text.
- Identify likely root cause(s).
- Propose a minimal fix plan and verification steps.
- No speculation: ask for missing info if needed.`;
      const failedAnnotations = failed.flatMap((run) => {
        const annotations = Array.isArray(run.annotations) ? run.annotations : [];
        return annotations.map((annotation) => ({
          run: run.name,
          level: annotation.level,
          title: annotation.title,
          path: annotation.path,
          startLine: annotation.startLine,
          endLine: annotation.endLine,
          message: annotation.message,
          rawDetails: annotation.rawDetails,
        }));
      });
      const payloadText = `GitHub PR failed checks (JSON)\n${JSON.stringify({
        repo: context.repo ?? null,
        pr: context.pr ?? null,
        failedChecks: failed,
        failedAnnotations,
      }, null, 2)}`;

      dispatchSyntheticPrompt(target, visibleText, instructionsText, payloadText);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Failed to load checks', { description: message });
    }
  }, [directory, dispatchSyntheticPrompt, github, pr, resolveChatDispatchTarget, setActiveMainTab]);

  const sendCommentsToChat = React.useCallback(async () => {
    setActiveMainTab('chat');

    if (!github?.prContext) {
      toast.error('GitHub runtime API unavailable');
      return;
    }
    if (!directory || !pr) return;
    const target = resolveChatDispatchTarget();
    if (!target) {
      return;
    }

    try {
      const context = await github.prContext(directory, pr.number, { includeDiff: false, includeCheckDetails: false });
      const issueComments = context.issueComments ?? [];
      const reviewComments = context.reviewComments ?? [];
      const total = issueComments.length + reviewComments.length;
      if (total === 0) {
        toast.message('No PR comments');
        return;
      }

      const visibleText = 'Review these PR comments and propose the required changes and next actions. Do not implement until I confirm.';
      const instructionsText = `Use the attached comments payload.
- Identify required vs optional changes.
- Call out intent/implementation mismatch if present.
- Propose a minimal plan and verification steps.
- No speculation: ask for missing info if needed.`;
      const payloadText = `GitHub PR comments (JSON)\n${JSON.stringify({
        repo: context.repo ?? null,
        pr: context.pr ?? null,
        issueComments,
        reviewComments,
      }, null, 2)}`;

      dispatchSyntheticPrompt(target, visibleText, instructionsText, payloadText);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Failed to load PR comments', { description: message });
    }
  }, [directory, dispatchSyntheticPrompt, github, pr, resolveChatDispatchTarget, setActiveMainTab]);

  const sendSingleCommentToChat = React.useCallback((comment: TimelineCommentItem) => {
    setCommentsDialogOpen(false);
    setActiveMainTab('chat');

    const target = resolveChatDispatchTarget();
    if (!target) {
      return;
    }

    const visibleText = 'Address this comment from PR and propose required changes. Do not implement until I confirm.';
    const instructionsText = `Use the attached single-comment payload.
- Explain what the reviewer is asking for.
- Identify exact code areas likely impacted.
- Propose a minimal implementation plan and verification steps.
- Call out ambiguity and ask focused follow-up questions if needed.`;
    const payloadText = `GitHub PR comment (JSON)\n${JSON.stringify({
      repo: commentsDetails?.repo ?? null,
      pr: commentsDetails?.pr ?? pr ?? null,
      comment,
    }, null, 2)}`;

    dispatchSyntheticPrompt(target, visibleText, instructionsText, payloadText);
  }, [commentsDetails, dispatchSyntheticPrompt, pr, resolveChatDispatchTarget, setActiveMainTab]);

  React.useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const refresh = React.useCallback(async (options?: { force?: boolean; onlyExistingPr?: boolean; silent?: boolean; markInitialResolved?: boolean }) => {
    if (!canShow) return;
    if (options?.onlyExistingPr && !statusRef.current?.pr) {
      return;
    }
    if (!options?.force && Date.now() - lastRefreshAtRef.current < PR_REVALIDATE_TTL_MS) {
      return;
    }
    if (isRefreshInFlightRef.current) {
      return;
    }

    isRefreshInFlightRef.current = true;
    lastRefreshAtRef.current = Date.now();

    if (githubAuthChecked && githubAuthStatus?.connected === false) {
      setStatus({ connected: false });
      setError(null);
      if (!options?.silent) {
        setIsLoading(false);
      }
      if (options?.markInitialResolved !== false) {
        setIsInitialStatusResolved(true);
      }
      isRefreshInFlightRef.current = false;
      return;
    }
    if (!github?.prStatus) {
      setStatus(null);
      setError('GitHub runtime API unavailable');
      if (options?.markInitialResolved !== false) {
        setIsInitialStatusResolved(true);
      }
      isRefreshInFlightRef.current = false;
      return;
    }
    if (!options?.silent) {
      setIsLoading(true);
    }
    setError(null);
    try {
      const next = await github.prStatus(directory, branch, selectedRemote?.name);
      setStatus((prev) => {
        const nextPr = next.pr;
        const prevPr = prev?.pr;
        // Some runtimes occasionally return PR status without body.
        // Keep already hydrated description for the same PR number.
        const shouldCarryBody = Boolean(
          nextPr
          && prevPr
          && nextPr.number === prevPr.number
          && (!nextPr.body || !nextPr.body.trim())
          && typeof prevPr.body === 'string'
          && prevPr.body.trim().length > 0,
        );

        if (!shouldCarryBody || !nextPr) {
          return next;
        }

        const carriedBody = prevPr?.body;
        if (!carriedBody) {
          return next;
        }

        return {
          ...next,
          pr: {
            ...nextPr,
            body: carriedBody,
          },
        };
      });
      if (next.connected === false) {
        setError(null);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message || 'Failed to load PR status');
    } finally {
      if (!options?.silent) {
        setIsLoading(false);
      }
      if (options?.markInitialResolved !== false) {
        setIsInitialStatusResolved(true);
      }
      isRefreshInFlightRef.current = false;
    }
  }, [branch, canShow, directory, github, githubAuthChecked, githubAuthStatus, selectedRemote?.name]);

  // Refetch PR status when selected remote changes
  const handleRemoteChange = React.useCallback((remote: GitRemote) => {
    setSelectedRemote(remote);
    // Clear current status and refetch
    setStatus(null);
    setError(null);
    lastRefreshAtRef.current = 0; // Force refresh
  }, []);

  React.useEffect(() => {
    const snapshot = pullRequestDraftSnapshots.get(snapshotKey) ?? null;
    const statusSnapshot = pullRequestStatusSnapshots.get(snapshotKey) ?? null;
    setTitle(snapshot?.title ?? branchToTitle(branch));
    setBody(snapshot?.body ?? '');
    setDraft(snapshot?.draft ?? false);
    setTargetBaseBranch(snapshot?.targetBaseBranch ? normalizeBranchRef(snapshot.targetBaseBranch) : normalizeBranchRef(baseBranch));
    setSelectedRemote(
      pickInitialPrRemote(remotes, {
        selectedRemoteName: snapshot?.selectedRemoteName,
        trackingBranch,
      })
    );
    setStatus(statusSnapshot);
    setError(null);
    setIsInitialStatusResolved(Boolean(statusSnapshot));
    void refresh({ force: true, markInitialResolved: true });
  }, [baseBranch, branch, refresh, remotes, snapshotKey, trackingBranch]);

  // Refetch when selected remote changes
  React.useEffect(() => {
    if (selectedRemote) {
      void refresh({ force: true, markInitialResolved: true });
    }
  }, [selectedRemote, refresh]);

  React.useEffect(() => {
    const onFocus = () => {
      void refresh({ force: true, silent: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refresh({ force: true, silent: true });
      }
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  React.useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      const hasPr = Boolean(statusRef.current?.pr);
      if (!hasPr) {
        const now = Date.now();
        const shouldRunDiscovery = now - lastDiscoveryPollAtRef.current >= PR_DISCOVERY_INTERVAL_MS;
        if (!shouldRunDiscovery) {
          return;
        }
        lastDiscoveryPollAtRef.current = now;
        void refresh({ force: true, silent: true });
        return;
      }

      void refresh({ onlyExistingPr: true, force: true, silent: true });
    }, PR_REVALIDATE_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [refresh]);

  React.useEffect(() => {
    if (githubAuthChecked && githubAuthStatus?.connected === false) {
      setStatus({ connected: false });
      setError(null);
    }
  }, [githubAuthChecked, githubAuthStatus]);

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
      selectedRemoteName: selectedRemote?.name,
    });
  }, [snapshotKey, title, body, draft, additionalContext, targetBaseBranch, selectedRemote?.name, directory, branch]);

  React.useEffect(() => {
    if (!status) {
      return;
    }
    pullRequestStatusSnapshots.set(snapshotKey, status);
  }, [snapshotKey, status]);

  const generateDescription = React.useCallback(async () => {
    if (isGenerating) return;
    if (!directory) return;
    setIsGenerating(true);
    try {
      const { getResolvedGitGenerationModel, settingsZenModel } = useConfigStore.getState();
      const resolvedModel = getResolvedGitGenerationModel();
      const payload: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string } = {
        base: targetBaseBranch,
        head: branch,
      };
      if (additionalContext) {
        payload.context = additionalContext;
      }
      if (resolvedModel) {
        payload.providerId = resolvedModel.providerId;
        payload.modelId = resolvedModel.modelId;
        if (resolvedModel.providerId === 'zen') {
          payload.zenModel = resolvedModel.modelId;
        }
      } else if (settingsZenModel) {
        payload.zenModel = settingsZenModel;
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
      toast.error('Failed to generate description', { description: message });
    } finally {
      setIsGenerating(false);
    }
  }, [branch, directory, isGenerating, additionalContext, onGeneratedDescription, targetBaseBranch]);

  const createPr = React.useCallback(async () => {
    if (!github?.prCreate) {
      toast.error('GitHub runtime API unavailable');
      return;
    }
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error('Title is required');
      return;
    }

    const trimmedBase = targetBaseBranch.trim();
    if (!trimmedBase) {
      toast.error('Base branch is required');
      return;
    }
    if (trimmedBase === branch) {
      toast.error('Base branch must differ from head branch');
      return;
    }

    setIsCreating(true);
    try {
      // Let the server determine the head source from tracking info
      // The server will check the branch's tracking remote and use that
      const pr = await github.prCreate({
        directory,
        title: trimmedTitle,
        head: branch,
        base: trimmedBase,
        ...(body.trim() ? { body } : {}),
        draft,
        ...(selectedRemote ? { remote: selectedRemote.name } : {}),
      });
      toast.success('PR created');
      setStatus((prev) => (prev ? { ...prev, pr } : prev));
      await refresh({ force: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Failed to create PR', { description: message });
    } finally {
      setIsCreating(false);
    }
  }, [body, branch, directory, draft, github, refresh, selectedRemote, targetBaseBranch, title]);

  const mergePr = React.useCallback(async (pr: GitHubPullRequest) => {
    if (!github?.prMerge) {
      toast.error('GitHub runtime API unavailable');
      return;
    }
    setIsMerging(true);
    try {
      const result = await github.prMerge({ directory, number: pr.number, method: mergeMethod });
      if (result.merged) {
        toast.success('PR merged');
      } else {
        toast.message('PR not merged', { description: result.message || 'Not mergeable' });
      }
      await refresh({ force: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Merge failed', { description: message });
      if (pr.url) {
        void openExternal(pr.url);
      }
    } finally {
      setIsMerging(false);
    }
  }, [directory, github, mergeMethod, refresh]);

  const markReady = React.useCallback(async (pr: GitHubPullRequest) => {
    if (!github?.prReady) {
      toast.error('GitHub runtime API unavailable');
      return;
    }
    setIsMarkingReady(true);
    try {
      await github.prReady({ directory, number: pr.number });
      toast.success('Marked ready for review');
      await refresh({ force: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Failed to mark ready', { description: message });
      if (pr.url) {
        void openExternal(pr.url);
      }
    } finally {
      setIsMarkingReady(false);
    }
  }, [directory, github, refresh]);

  const updatePr = React.useCallback(async (pr: GitHubPullRequest) => {
    if (!github?.prUpdate) {
      toast.error('GitHub runtime API unavailable');
      return;
    }

    const trimmedTitle = editTitle.trim();
    if (!trimmedTitle) {
      toast.error('Title is required');
      return;
    }

    setIsUpdating(true);
    try {
      const updated = await github.prUpdate({
        directory,
        number: pr.number,
        title: trimmedTitle,
        body: editBody,
      });
      setStatus((prev) => (prev
        ? {
            ...prev,
            pr: {
              ...(prev.pr ?? pr),
              ...updated,
            },
          }
        : prev));
      setIsEditingPr(false);
      toast.success('PR updated');
      await refresh({ force: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Failed to update PR', { description: message });
    } finally {
      setIsUpdating(false);
    }
  }, [directory, editBody, editTitle, github, refresh]);

  if (!canShow) {
    return null;
  }

  const repoUrl = status?.repo?.url || null;
  const checks = status?.checks ?? null;
  const canMerge = Boolean(status?.canMerge);
  const isConnected = Boolean(status?.connected);
  const shouldShowConnectionNotice = githubAuthChecked && status?.connected === false;
  const prVisualState = getPrVisualState(status);
  const prColorVar = prVisualState ? `var(--pr-${prVisualState})` : 'var(--status-info)';
  const PrStateIcon = prVisualState === 'draft'
    ? RiGitPrDraftLine
    : prVisualState === 'merged'
      ? RiGitMergeLine
      : prVisualState === 'closed'
        ? RiGitClosePullRequestLine
        : RiGitPullRequestLine;

  const containerClassName =
    variant === 'framed'
      ? 'rounded-xl border border-border/60 bg-background/70 overflow-hidden'
      : 'border-0 bg-transparent rounded-none';
  const headerClassName =
    variant === 'framed'
      ? 'px-3 py-2 border-b border-border/40 flex flex-col gap-1'
      : 'px-0 py-3 border-b border-border/40 flex flex-col gap-1';
  const bodyClassName = variant === 'framed' ? 'flex flex-col gap-3 p-3' : 'flex flex-col gap-3 py-3';

  return (
    <section className={containerClassName}>
      <div className={headerClassName}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {pr ? (
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background/70 hover:bg-interactive-hover/60"
                    onClick={() => void openExternal(pr.url)}
                    aria-label="Open PR on GitHub"
                  >
                    <PrStateIcon className="size-4 shrink-0" style={{ color: prColorVar }} />
                  </button>
                </TooltipTrigger>
                <TooltipContent><p>Open PR on GitHub</p></TooltipContent>
              </Tooltip>
            ) : (
              <PrStateIcon className="size-4 shrink-0" style={{ color: 'var(--surface-muted-foreground)' }} />
            )}
            <h3 className="typography-ui-header font-semibold text-foreground truncate">Pull Request</h3>
            {pr ? (
              <span className="typography-meta text-muted-foreground truncate">#{pr.number}</span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {isLoading ? <RiLoader4Line className="size-4 animate-spin text-muted-foreground" /> : null}
            {checks ? (
              <span className="inline-flex items-center gap-2 typography-micro text-muted-foreground">
                <span className={`h-2 w-2 rounded-full ${statusColor(checks.state)}`} />
                {checks.total > 0 ? `${checks.success}/${checks.total} checks` : `${checks.state} checks`}
              </span>
            ) : null}
            {hasMultipleRemotes ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-6 px-2 gap-1">
                    <span className="typography-micro">{selectedRemote?.name}</span>
                    <RiArrowDownSLine className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[200px]">
                  {remotes.map((remote) => (
                    <DropdownMenuItem
                      key={remote.name}
                      onSelect={() => handleRemoteChange(remote)}
                    >
                      <div className="flex flex-col">
                        <span className="typography-ui-label text-foreground">
                          {remote.name}
                          {remote.name === selectedRemote?.name && (
                            <span className="ml-2 text-primary">✓</span>
                          )}
                        </span>
                        <span className="typography-meta text-muted-foreground truncate">
                          {remote.pushUrl}
                        </span>
                      </div>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
        {pr ? (
          <div className="typography-micro text-muted-foreground">
            <span style={{ color: prColorVar }}>
              {pr.state}{pr.draft ? ' (draft)' : ''}
            </span>
            {pr.mergeable === false ? ' · not mergeable' : ''}
            {pr.state === 'open' && typeof pr.mergeableState === 'string' && pr.mergeableState && pr.mergeableState !== 'unknown'
              ? ` · ${pr.mergeableState}`
              : ''}
          </div>
        ) : null}
      </div>

      <div className={bodyClassName}>
        {shouldShowConnectionNotice ? (
          <div className="space-y-2">
            <div className="typography-meta text-muted-foreground">
              GitHub not connected. Connect your GitHub account in settings.
            </div>
                <Button variant="outline" size="sm" onClick={openGitHubSettings} className="w-fit">
                  Open settings
                </Button>
              </div>
            ) : null}

            {error ? (
              <div className="space-y-2">
                <div className="typography-ui-label text-foreground">PR status unavailable</div>
                <div className="typography-meta text-muted-foreground break-words">{error}</div>
                {repoUrl ? (
                  <Button variant="outline" size="sm" asChild className="w-fit">
                    <a href={repoUrl} target="_blank" rel="noopener noreferrer">
                      <RiExternalLinkLine className="size-4" />
                      Open Repo
                    </a>
                  </Button>
                ) : null}
              </div>
            ) : null}

            {!pr && !isInitialStatusResolved && !error && !shouldShowConnectionNotice ? (
              <div className="flex items-center gap-2 typography-micro text-muted-foreground">
                <RiLoader4Line className="size-4 animate-spin" />
                Checking PR status...
              </div>
            ) : pr ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-3">
                  <div className="min-w-0">
                    {isEditingPr ? (
                      <div className="space-y-2">
                        <Input
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          placeholder="PR title"
                          autoCorrect={hasTouchInput ? "on" : "off"}
                          autoCapitalize={hasTouchInput ? "sentences" : "off"}
                          spellCheck={hasTouchInput}
                        />
                        <Textarea
                          value={editBody}
                          onChange={(e) => setEditBody(e.target.value)}
                          className="min-h-[120px] bg-background/80"
                          placeholder="Describe this PR"
                          autoCorrect={hasTouchInput ? "on" : "off"}
                          autoCapitalize={hasTouchInput ? "sentences" : "off"}
                          spellCheck={hasTouchInput}
                        />
                      </div>
                    ) : (
                      <>
                        <div className="typography-markdown text-xl font-semibold text-foreground break-words leading-snug">{pr.title}</div>
                        {pr.body?.trim() ? (
                          <SimpleMarkdownRenderer
                            content={pr.body}
                            className="typography-markdown-body text-muted-foreground break-words mt-1"
                          />
                        ) : (
                          <div className="typography-micro text-muted-foreground whitespace-pre-wrap break-words mt-1">
                            {isHydratingCurrentPrBody ? 'Loading description...' : 'No description provided.'}
                          </div>
                        )}
                      </>
                    )}
                    {canMerge && pr.draft ? (
                      <div className="typography-micro text-muted-foreground">
                        Draft PRs must be marked ready before merge.
                      </div>
                    ) : null}
                    {!canMerge ? (
                      <div className="typography-micro text-muted-foreground">No merge permission; use Open in GitHub.</div>
                    ) : null}
                  </div>

                  <div className="order-first w-full flex flex-wrap items-center gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {pr.state === 'open' ? (
                        isEditingPr ? (
                          <>
                            <Tooltip delayDuration={300}>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="w-8 px-0"
                                  onClick={() => {
                                    setIsEditingPr(false);
                                    setEditTitle(pr.title || '');
                                    setEditBody(pr.body || '');
                                  }}
                                  disabled={isUpdating}
                                  aria-label="Cancel editing"
                                >
                                  <RiCloseLine className="size-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent><p>Cancel editing</p></TooltipContent>
                            </Tooltip>
                            <Tooltip delayDuration={300}>
                              <TooltipTrigger asChild>
                                <Button
                                  size="sm"
                                  className="w-8 px-0"
                                  onClick={() => updatePr(pr)}
                                  disabled={isUpdating || !editTitle.trim()}
                                  aria-label="Save PR title and description"
                                >
                                  {isUpdating ? <RiLoader4Line className="size-4 animate-spin" /> : <RiCheckLine className="size-4" />}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent><p>Save PR title and description</p></TooltipContent>
                            </Tooltip>
                          </>
                        ) : (
                          <Tooltip delayDuration={300}>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                className="w-8 px-0"
                                onClick={() => setIsEditingPr(true)}
                                aria-label="Edit PR title and description"
                              >
                                <RiEditLine className="size-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent><p>Edit PR title and description</p></TooltipContent>
                          </Tooltip>
                        )
                      ) : null}

                      {checks ? (
                        <Tooltip delayDuration={300}>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-8 px-0"
                              onClick={openChecksDialog}
                              disabled={isLoadingCheckDetails}
                              aria-label="Open checks details"
                            >
                              {isLoadingCheckDetails ? <RiLoader4Line className="size-4 animate-spin" /> : <RiInformationLine className="size-4" />}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent><p>Open checks details</p></TooltipContent>
                        </Tooltip>
                      ) : null}

                      {checks?.failure ? (
                        <Tooltip delayDuration={300}>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-8 px-0 border-[var(--status-success-border)] bg-[var(--status-success-background)] text-[var(--status-success)]"
                              onClick={sendFailedChecksToChat}
                              aria-label="Resolve failed checks with agent"
                            >
                              <RiErrorWarningLine className="size-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent><p>Resolve failed checks with agent</p></TooltipContent>
                        </Tooltip>
                      ) : null}

                      <Tooltip delayDuration={300}>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-8 px-0"
                            onClick={openCommentsDialog}
                            aria-label="Open PR comments"
                          >
                            <RiChat4Line className="size-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent><p>Open PR comments</p></TooltipContent>
                      </Tooltip>

                      <Tooltip delayDuration={300}>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-8 px-0 border-[var(--status-success-border)] bg-[var(--status-success-background)] text-[var(--status-success)]"
                            onClick={sendCommentsToChat}
                            aria-label="Share comments with agent"
                          >
                            <RiAiGenerate2 className="size-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent><p>Share comments with agent</p></TooltipContent>
                      </Tooltip>

                      {canMerge && pr.draft && pr.state === 'open' ? (
                        <Tooltip delayDuration={300}>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-8 px-0"
                              onClick={() => markReady(pr)}
                              disabled={isMarkingReady || isMerging || isUpdating || isEditingPr}
                              aria-label="Mark PR ready for review"
                            >
                              {isMarkingReady ? <RiLoader4Line className="size-4 animate-spin" /> : <RiCheckboxCircleLine className="size-4" />}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent><p>Mark PR ready for review</p></TooltipContent>
                        </Tooltip>
                      ) : null}
                    </div>

                    <div className="ml-auto flex items-center gap-2">
                      {canMerge ? (
                        <>
                          <Select
                            value={mergeMethod}
                            onValueChange={(value) => setMergeMethod(value as MergeMethod)}
                            disabled={isMerging || pr.state !== 'open'}
                          >
                            <SelectTrigger size="lg" className="h-8 w-auto min-w-0">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="squash">Squash</SelectItem>
                              <SelectItem value="merge">Merge</SelectItem>
                              <SelectItem value="rebase">Rebase</SelectItem>
                            </SelectContent>
                          </Select>
                          <Tooltip delayDuration={300}>
                            <TooltipTrigger asChild>
                              <Button
                                size="sm"
                                className="w-8 px-0"
                                onClick={() => mergePr(pr)}
                                disabled={isMerging || isMarkingReady || pr.state !== 'open' || pr.draft || isUpdating || isEditingPr}
                                aria-label="Merge pull request"
                              >
                                {isMerging ? <RiLoader4Line className="size-4 animate-spin" /> : <RiGitMergeLine className="size-4" />}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent><p>Merge pull request</p></TooltipContent>
                          </Tooltip>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="typography-ui-label text-foreground">Create PR</div>
                    <div className="typography-micro text-muted-foreground truncate">
                      {branch} → {targetBaseBranch}
                    </div>
                  </div>
                  {repoUrl ? (
                    <Button variant="outline" size="sm" asChild>
                      <a href={repoUrl} target="_blank" rel="noopener noreferrer">
                        <RiExternalLinkLine className="size-4" />
                        Repo
                      </a>
                    </Button>
                  ) : null}
                </div>

                <label className="space-y-1">
                  <div className="typography-micro text-muted-foreground">Title</div>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="PR title"
                    autoCorrect={hasTouchInput ? "on" : "off"}
                    autoCapitalize={hasTouchInput ? "sentences" : "off"}
                    spellCheck={hasTouchInput}
                  />
                </label>

                <label className="space-y-1">
                  <div className="typography-micro text-muted-foreground">Base branch</div>
                  {availableBaseBranches.length > 0 ? (
                    <Select value={targetBaseBranch} onValueChange={setTargetBaseBranch}>
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder="Select base branch" />
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
                      placeholder="main"
                    />
                  )}
                </label>

                <label className="space-y-1">
                  <div className="typography-micro text-muted-foreground">Description</div>
                  <Textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    className="min-h-[110px] bg-background/80"
                    placeholder="What changed and why"
                    autoCorrect={hasTouchInput ? "on" : "off"}
                    autoCapitalize={hasTouchInput ? "sentences" : "off"}
                    spellCheck={hasTouchInput}
                  />
                </label>

                <div
                  className="flex items-center gap-2 cursor-pointer"
                  role="button"
                  tabIndex={0}
                  aria-pressed={draft}
                  onClick={() => setDraft((v) => !v)}
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                      e.preventDefault();
                      setDraft((v) => !v);
                    }
                  }}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDraft((v) => !v);
                    }}
                    aria-label="Toggle draft PR"
                    className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    {draft ? (
                      <RiCheckboxLine className="size-4 text-primary" />
                    ) : (
                      <RiCheckboxBlankLine className="size-4" />
                    )}
                  </button>
                  <span className="typography-ui-label text-foreground select-none">Draft</span>
                </div>

                {/* Additional Context Section */}
                {isMobile ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="typography-micro text-muted-foreground">
                        Additional context (optional)
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setIsContextSheetOpen(true)}
                      >
                        {additionalContext.trim() ? 'Edit' : 'Add'}
                      </Button>
                    </div>
                    {additionalContext.trim() && (
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center rounded-full bg-[var(--interactive-selection)] px-2 py-0.5 text-xs text-[var(--interactive-selection-foreground)]">
                          Context added
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <Collapsible open={isContextOpen} onOpenChange={setIsContextOpen}>
                    <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-3 py-2 hover:bg-[var(--interactive-hover)]">
                      <span className="typography-micro text-muted-foreground">
                        Additional context (optional)
                      </span>
                      <span className="typography-micro text-[var(--primary-base)]">
                        {isContextOpen ? 'Hide' : additionalContext.trim() ? 'Edit' : 'Add'}
                      </span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="mt-2 space-y-2 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-3">
                        <Textarea
                          value={additionalContext}
                          onChange={(e) => setAdditionalContext(e.target.value)}
                          className="min-h-[100px] bg-transparent"
                          placeholder="Explain why this change is needed...&#10;Mention how to test (commands / steps)...&#10;Call out risks / rollout plan..."
                        />
                        <p className="typography-micro text-muted-foreground">
                          This text is only used to guide PR generation.
                        </p>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )}

                {/* Mobile Sheet for Context */}
                <MobileOverlayPanel
                  open={isContextSheetOpen}
                  onClose={() => setIsContextSheetOpen(false)}
                  title="Additional context"
                  footer={
                    <Button
                      size="sm"
                      onClick={() => setIsContextSheetOpen(false)}
                      className="w-full"
                    >
                      Done
                    </Button>
                  }
                >
                  <div className="space-y-3">
                    <Textarea
                      value={additionalContext}
                      onChange={(e) => setAdditionalContext(e.target.value)}
                      className="min-h-[200px] bg-transparent"
                      placeholder="Explain why this change is needed...&#10;Mention how to test (commands / steps)...&#10;Call out risks / rollout plan..."
                      autoFocus
                    />
                    <p className="typography-micro text-muted-foreground">
                      This text is only used to guide PR generation.
                    </p>
                  </div>
                </MobileOverlayPanel>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={generateDescription}
                    disabled={isGenerating || isCreating}
                  >
                    {isGenerating ? <RiLoader4Line className="size-4 animate-spin" /> : <RiAiGenerate2 className="size-4 text-primary" />}
                    Generate
                  </Button>
                  <div className="flex-1" />
                  <Button
                    size="sm"
                    className="min-w-[7.5rem] justify-center gap-2"
                    onClick={createPr}
                    disabled={isCreating || !isConnected || !targetBaseBranch.trim() || targetBaseBranch.trim() === branch}
                  >
                    <span className="inline-flex size-4 items-center justify-center">
                      {isCreating ? <RiLoader4Line className="size-4 animate-spin" /> : <RiGitPullRequestLine className="size-4" />}
                    </span>
                    <span>Create PR</span>
                  </Button>
                </div>
              </div>
            )}
      </div>

      <Dialog open={checksDialogOpen} onOpenChange={setChecksDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[70vh] flex flex-col min-h-0">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RiGitPullRequestLine className="h-5 w-5" />
              Check Details
            </DialogTitle>
            <DialogDescription>
              {pr ? `PR #${pr.number}` : 'Pull request'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto mt-2">
            {isLoadingCheckDetails ? (
              <div className="text-center text-muted-foreground py-8 flex items-center justify-center gap-2">
                <RiLoader4Line className="h-4 w-4 animate-spin" />
                Loading...
              </div>
            ) : null}

            {!isLoadingCheckDetails ? (
              <div className="space-y-3">
                {Array.isArray(checkDetails?.checkRuns) && checkDetails?.checkRuns.length > 0 ? (
                  checkDetails.checkRuns.map((run, idx) => {
                    const key = `${run.id ?? 'run'}:${run.job?.jobId ?? 'job'}:${run.name}:${idx}`;
                    return (
                      <div key={key} className="p-1">
                        {renderCheckRunSummary(run)}
                      </div>
                    );
                  })
                ) : (
                  <div className="text-center text-muted-foreground py-8">No check details available.</div>
                )}
              </div>
            ) : null}
          </div>

        </DialogContent>
      </Dialog>

      <Dialog open={commentsDialogOpen} onOpenChange={setCommentsDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[82vh] min-h-[38rem] flex flex-col gap-2">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RiGitPullRequestLine className="h-5 w-5" />
              PR Comments
              {pr ? (
                <span className="typography-meta text-muted-foreground">PR #{pr.number}</span>
              ) : null}
            </DialogTitle>
          </DialogHeader>

          <ScrollShadow className="mt-2 max-h-[66vh] overflow-y-auto overlay-scrollbar-target overlay-scrollbar-container">
            {isLoadingCommentsDetails ? (
              <div className="text-center text-muted-foreground py-8 flex items-center justify-center gap-2">
                <RiLoader4Line className="h-4 w-4 animate-spin" />
                Loading...
              </div>
            ) : null}

            {!isLoadingCommentsDetails ? (
              <div className="space-y-4">
                {timelineComments.length > 0 ? (
                  <div className="relative pl-3">
                    <div>
                      {timelineComments.map((comment, idx) => {
                        const initial = (comment.authorName || '?').charAt(0).toUpperCase();
                        const isLast = idx === timelineComments.length - 1;
                        return (
                          <div key={comment.id} className="relative pl-10 pb-5 last:pb-0">
                            {!isLast ? <div className="absolute left-4 top-[2.375rem] bottom-[0.375rem] w-px bg-border/60" /> : null}
                            <div className="absolute left-0 top-0 z-10 flex size-8 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-surface-elevated text-xs text-muted-foreground">
                              {comment.avatarUrl ? (
                                <img src={comment.avatarUrl} alt={comment.authorName} className="h-full w-full object-cover" />
                              ) : (
                                <span>{initial}</span>
                              )}
                            </div>
                            <div className="rounded-lg bg-surface-elevated px-3 pt-0 pb-3 space-y-2">
                              <div className="flex flex-col items-start gap-1 typography-micro text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-1 sm:gap-y-1">
                                <span className="text-foreground whitespace-nowrap">
                                  {comment.authorName}
                                  {comment.authorLogin && comment.authorLogin !== comment.authorName ? ` · @${comment.authorLogin}` : ''}
                                </span>
                                {comment.createdAt ? <span className="whitespace-nowrap">{formatTimestamp(comment.createdAt)}</span> : null}
                                <Tooltip delayDuration={300}>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 px-0 has-[>svg]:px-0 sm:px-2 sm:has-[>svg]:px-2.5 text-[var(--status-success)] hover:bg-[var(--status-success-background)] hover:text-[var(--status-success)] justify-start"
                                      onClick={() => sendSingleCommentToChat(comment)}
                                      aria-label="Send this comment to agent"
                                    >
                                      <RiAiGenerate2 className="size-3.5" />
                                      Send to agent
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent><p>Send this comment to agent</p></TooltipContent>
                                </Tooltip>
                              </div>
                              <div className="typography-micro text-muted-foreground">
                                {comment.context}
                                {comment.path ? ` · ${comment.path}` : ''}
                                {comment.line ? `:${comment.line}` : ''}
                              </div>
                              <SimpleMarkdownRenderer
                                content={linkifyMentionsMarkdown(comment.body)}
                                className={[
                                  'typography-markdown-body text-foreground break-words [&_a]:no-underline [&_a:hover]:no-underline',
                                  selfMentionHighlightClass,
                                ].filter(Boolean).join(' ')}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="text-center text-muted-foreground py-8">No comments found.</div>
                )}
              </div>
            ) : null}
          </ScrollShadow>

        </DialogContent>
      </Dialog>
    </section>
  );
};
