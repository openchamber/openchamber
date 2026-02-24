import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import {
  RiCheckboxBlankLine,
  RiCheckboxLine,
  RiExternalLinkLine,
  RiGitPullRequestLine,
  RiLoader4Line,
  RiSearchLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useMessageStore } from '@/stores/messageStore';
import { useContextStore } from '@/stores/contextStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { opencodeClient } from '@/lib/opencode/client';
import { createWorktreeSessionForNewBranchExact } from '@/lib/worktreeSessionCreator';
import { validateWorktreeCreate } from '@/lib/worktrees/worktreeManager';
import { getRemotes } from '@/lib/gitApi';
import type {
  GitHubPullRequestContextResult,
  GitHubPullRequestHeadRepo,
  GitHubPullRequestSummary,
  GitHubPullRequestsListResult,
  GitRemote,
} from '@/lib/api/types';

const parsePullRequestNumber = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/\/pull\/(\d+)(?:\b|\/|$)/i);
  if (urlMatch) {
    const parsed = Number(urlMatch[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  const hashMatch = trimmed.match(/^#?(\d+)$/);
  if (hashMatch) {
    const parsed = Number(hashMatch[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
};

const buildPullRequestContextText = (payload: GitHubPullRequestContextResult) => {
  return `GitHub pull request context (JSON)\n${JSON.stringify(payload, null, 2)}`;
};

const sanitizeGitRemoteName = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
};

const looksLikeSshUrl = (value: string): boolean => {
  const trimmed = value.trim();
  return /^git@/i.test(trimmed) || /^ssh:\/\//i.test(trimmed);
};

const resolvePreferredPushTransport = (remotes: GitRemote[]): 'ssh' | 'https' => {
  const candidates = remotes.length > 0
    ? remotes
    : [];
  const preferredByName = candidates.find((remote) => remote.name === 'origin')
    || candidates.find((remote) => remote.name === 'upstream')
    || candidates[0];

  const sample = preferredByName?.pushUrl || preferredByName?.fetchUrl || '';
  return looksLikeSshUrl(sample) ? 'ssh' : 'https';
};

const resolveForkRemoteUrl = (headRepo: GitHubPullRequestHeadRepo | null | undefined, preferredTransport: 'ssh' | 'https'): string => {
  if (!headRepo) {
    return '';
  }

  if (preferredTransport === 'ssh') {
    return headRepo.sshUrl || headRepo.cloneUrl || headRepo.url || '';
  }

  return headRepo.cloneUrl || headRepo.sshUrl || headRepo.url || '';
};

export function GitHubPullRequestPickerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { github } = useRuntimeAPIs();
  const githubAuthStatus = useGitHubAuthStore((state) => state.status);
  const githubAuthChecked = useGitHubAuthStore((state) => state.hasChecked);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const activeProject = useProjectsStore((state) => state.getActiveProject());

  const projectDirectory = activeProject?.path ?? null;
  const projectRef = React.useMemo(() => {
    if (!projectDirectory) {
      return null;
    }
    return {
      id: activeProject?.id ?? `path:${projectDirectory}`,
      path: projectDirectory,
    };
  }, [activeProject?.id, projectDirectory]);

  const [query, setQuery] = React.useState('');
  const [createInWorktree, setCreateInWorktree] = React.useState(false);
  const [includeDiff, setIncludeDiff] = React.useState(false);
  const [result, setResult] = React.useState<GitHubPullRequestsListResult | null>(null);
  const [prs, setPrs] = React.useState<GitHubPullRequestSummary[]>([]);
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const [startingNumber, setStartingNumber] = React.useState<number | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [existingBranchHeads, setExistingBranchHeads] = React.useState<Map<string, boolean>>(new Map());
  const [projectRemotes, setProjectRemotes] = React.useState<GitRemote[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const preferredPushTransport = React.useMemo(
    () => resolvePreferredPushTransport(projectRemotes),
    [projectRemotes]
  );

  const refresh = React.useCallback(async () => {
    if (!projectDirectory) {
      setResult(null);
      setError('No active project');
      return;
    }
    if (githubAuthChecked && githubAuthStatus?.connected === false) {
      setResult({ connected: false });
      setPrs([]);
      setHasMore(false);
      setPage(1);
      setError(null);
      return;
    }
    if (!github?.prsList) {
      setResult(null);
      setError('GitHub runtime API unavailable');
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const next = await github.prsList(projectDirectory, { page: 1 });
      setResult(next);
      setPrs(next.prs ?? []);
      setPage(next.page ?? 1);
      setHasMore(Boolean(next.hasMore));
      if (next.connected === false) {
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, [github, githubAuthChecked, githubAuthStatus, projectDirectory]);

  const loadMore = React.useCallback(async () => {
    if (!projectDirectory) return;
    if (!github?.prsList) return;
    if (isLoadingMore || isLoading) return;
    if (!hasMore) return;

    setIsLoadingMore(true);
    try {
      const nextPage = page + 1;
      const next = await github.prsList(projectDirectory, { page: nextPage });
      setResult(next);
      setPrs((prev) => [...prev, ...(next.prs ?? [])]);
      setPage(next.page ?? nextPage);
      setHasMore(Boolean(next.hasMore));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Failed to load more PRs', { description: message });
    } finally {
      setIsLoadingMore(false);
    }
  }, [github, hasMore, isLoading, isLoadingMore, page, projectDirectory]);

  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setCreateInWorktree(false);
      setIncludeDiff(false);
      setResult(null);
      setPrs([]);
      setPage(1);
      setHasMore(false);
      setStartingNumber(null);
      setIsLoading(false);
      setError(null);
      setExistingBranchHeads(new Map());
      setProjectRemotes([]);
      return;
    }
    void refresh();
  }, [open, refresh]);

  React.useEffect(() => {
    if (!open || !projectDirectory) {
      return;
    }

    let cancelled = false;
    void getRemotes(projectDirectory)
      .then((remotes) => {
        if (!cancelled) {
          setProjectRemotes(Array.isArray(remotes) ? remotes : []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectRemotes([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, projectDirectory]);

  const checkLocalBranchExists = React.useCallback(async (heads: string[]) => {
    if (!projectRef) return;
    const unique = Array.from(new Set(heads.map((h) => (h || '').trim()).filter(Boolean)));
    if (unique.length === 0) return;

    // Only check unknown heads (optimistic enable; disable after result arrives).
    const unknown = unique.filter((h) => !existingBranchHeads.has(h));
    if (unknown.length === 0) return;

    const results = await Promise.all(
      unknown.map(async (head) => {
        const validation = await validateWorktreeCreate(projectRef, {
          mode: 'new',
          branchName: head,
          worktreeName: head,
        }).catch(() => ({ ok: false, errors: [{ code: 'validation_failed', message: 'Validation failed' }] }));

        const blockedByBranch = validation.errors.some((entry) =>
          entry.code === 'branch_in_use' || entry.code === 'branch_exists'
        );
        return { head, blocked: blockedByBranch };
      })
    );

    setExistingBranchHeads((prev) => {
      const next = new Map(prev);
      for (const item of results) {
        next.set(item.head, item.blocked);
      }
      return next;
    });
  }, [projectRef, existingBranchHeads]);

  React.useEffect(() => {
    if (!open) return;
    if (!projectRef) return;
    if (!createInWorktree) return;
    void checkLocalBranchExists(prs.map((pr) => pr.head));
  }, [open, projectRef, createInWorktree, prs, checkLocalBranchExists]);

  React.useEffect(() => {
    if (!open) return;
    if (githubAuthChecked && githubAuthStatus?.connected === false) {
      setResult({ connected: false });
      setPrs([]);
      setHasMore(false);
      setPage(1);
      setError(null);
    }
  }, [githubAuthChecked, githubAuthStatus, open]);

  const connected = githubAuthChecked ? result?.connected !== false : true;
  const repoUrl = result?.repo?.url ?? null;

  const openGitHubSettings = React.useCallback(() => {
    setSettingsPage('github');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return prs;
    return prs.filter((pr) => {
      if (String(pr.number) === q.replace(/^#/, '')) return true;
      return pr.title.toLowerCase().includes(q);
    });
  }, [prs, query]);

  const isPrDisabledForWorktree = React.useCallback((pr: GitHubPullRequestSummary): boolean => {
    if (!createInWorktree) return false;
    const head = pr.head?.trim();
    if (!head) return true;
    const exists = existingBranchHeads.get(head);
    // Optimistic: treat unknown as enabled.
    return exists === true;
  }, [createInWorktree, existingBranchHeads]);

  const directNumber = React.useMemo(() => parsePullRequestNumber(query), [query]);

  const resolveDefaultAgentName = React.useCallback((): string | undefined => {
    const configState = useConfigStore.getState();
    const visibleAgents = configState.getVisibleAgents();

    if (configState.settingsDefaultAgent) {
      const settingsAgent = visibleAgents.find((a) => a.name === configState.settingsDefaultAgent);
      if (settingsAgent) {
        return settingsAgent.name;
      }
    }

    return visibleAgents.find((agent) => agent.name === 'build')?.name || visibleAgents[0]?.name;
  }, []);

  const resolveDefaultModelSelection = React.useCallback((): { providerID: string; modelID: string } | null => {
    const configState = useConfigStore.getState();
    const settingsDefaultModel = configState.settingsDefaultModel;
    if (!settingsDefaultModel) return null;

    const parts = settingsDefaultModel.split('/');
    if (parts.length !== 2) return null;
    const [providerID, modelID] = parts;
    if (!providerID || !modelID) return null;

    const modelMetadata = configState.getModelMetadata(providerID, modelID);
    if (!modelMetadata) return null;
    return { providerID, modelID };
  }, []);

  const resolveDefaultVariant = React.useCallback((providerID: string, modelID: string): string | undefined => {
    const configState = useConfigStore.getState();
    const settingsDefaultVariant = configState.settingsDefaultVariant;
    if (!settingsDefaultVariant) return undefined;

    const provider = configState.providers.find((p) => p.id === providerID);
    const model = provider?.models.find((m: Record<string, unknown>) => (m as { id?: string }).id === modelID) as
      | { variants?: Record<string, unknown> }
      | undefined;
    const variants = model?.variants;
    if (!variants) return undefined;
    if (!Object.prototype.hasOwnProperty.call(variants, settingsDefaultVariant)) return undefined;
    return settingsDefaultVariant;
  }, []);

  const createPrWorktreeSession = React.useCallback(async (
    baseRepo: GitHubPullRequestsListResult['repo'] | undefined,
    pr: GitHubPullRequestSummary,
  ): Promise<{ id: string } | null> => {
    if (!projectDirectory || !projectRef) return null;
    const headRef = pr.head;
    const headRepo = pr.headRepo;
    if (!headRef) {
      throw new Error('PR head ref missing');
    }

    const isFork = Boolean(
      headRepo?.owner && headRepo?.repo &&
      baseRepo?.owner && baseRepo?.repo &&
      (headRepo.owner !== baseRepo.owner || headRepo.repo !== baseRepo.repo)
    );

    const preferredBranch = pr.head;
    const remoteName = isFork
      ? (sanitizeGitRemoteName(`pr-${headRepo?.owner || 'fork'}-${headRepo?.repo || ''}`) || `pr-${pr.number}`)
      : 'origin';
    const remoteUrl = isFork ? resolveForkRemoteUrl(headRepo, preferredPushTransport) : '';

    if (isFork && !remoteUrl) {
      throw new Error('PR fork remote URL missing');
    }

    const startRef = `${remoteName}/${preferredBranch}`;
    const validation = await validateWorktreeCreate(projectRef, {
      mode: 'new',
      branchName: preferredBranch,
      worktreeName: preferredBranch,
      startRef,
      setUpstream: true,
      upstreamRemote: remoteName,
      upstreamBranch: preferredBranch,
      ensureRemoteName: isFork ? remoteName : undefined,
      ensureRemoteUrl: isFork ? remoteUrl : undefined,
    });

    if (!validation.ok) {
      const branchError = validation.errors.find((entry) =>
        entry.code === 'branch_in_use' || entry.code === 'branch_exists'
      );
      if (branchError) {
        throw new Error(branchError.message);
      }
      throw new Error(validation.errors[0]?.message || 'PR worktree validation failed');
    }

    // Prevent clobbering/removing an existing local branch when using PR worktree mode.
    if (existingBranchHeads.get(preferredBranch) === true) {
      throw new Error(`Local branch already exists: ${preferredBranch}`);
    }

    const session = await createWorktreeSessionForNewBranchExact(projectDirectory, preferredBranch, startRef, {
      kind: 'pr',
      worktreeName: preferredBranch,
      setUpstream: true,
      upstreamRemote: remoteName,
      upstreamBranch: preferredBranch,
      ensureRemoteName: isFork ? remoteName : undefined,
      ensureRemoteUrl: isFork ? remoteUrl : undefined,
      createdFromBranch: pr.base,
    });
    if (!session?.id) {
      throw new Error('Failed to create PR worktree session');
    }

    const meta = useSessionStore.getState().worktreeMetadata.get(session.id);
    const worktreeDir = meta?.path;
    if (!worktreeDir) {
      throw new Error('Worktree directory not found');
    }

    // Update stored metadata for better UX + reintegration target.
    useSessionStore.getState().setWorktreeMetadata(session.id, {
      ...(meta || { path: worktreeDir, projectDirectory, branch: preferredBranch, label: preferredBranch }),
      path: worktreeDir,
      projectDirectory,
      branch: preferredBranch,
      label: preferredBranch,
      createdFromBranch: pr.base,
      kind: 'pr' as const,
    });

    return { id: session.id };
  }, [projectDirectory, projectRef, existingBranchHeads, preferredPushTransport]);

  const startSession = React.useCallback(async (number: number) => {
    if (!projectDirectory) {
      toast.error('No active project');
      return;
    }
    if (!github?.prContext) {
      toast.error('GitHub runtime API unavailable');
      return;
    }
    if (startingNumber) return;
    setStartingNumber(number);
    try {
      const prContext = await github.prContext(projectDirectory, number, { includeDiff, includeCheckDetails: false });
      if (prContext.connected === false) {
        toast.error('GitHub not connected');
        return;
      }
      if (!prContext.repo) {
        toast.error('Repo not resolvable', { description: 'origin remote must be a GitHub URL' });
        return;
      }
      if (!prContext.pr) {
        toast.error('PR not found');
        return;
      }

      const pr = prContext.pr;
      const sessionTitle = `#${pr.number} ${pr.title}`.trim();

      const sessionId = await (async () => {
        if (createInWorktree) {
          const worktreeSession = await createPrWorktreeSession(prContext.repo, pr);
          return worktreeSession?.id || null;
        }
        const session = await useSessionStore.getState().createSession(sessionTitle, projectDirectory, null);
        return session?.id || null;
      })();

      if (!sessionId) {
        throw new Error('Failed to create session');
      }

      void useSessionStore.getState().updateSessionTitle(sessionId, sessionTitle).catch(() => undefined);
      try {
        useSessionStore.getState().initializeNewOpenChamberSession(sessionId, useConfigStore.getState().agents);
      } catch {
        // ignore
      }

      onOpenChange(false);

      const configState = useConfigStore.getState();
      const lastUsedProvider = useMessageStore.getState().lastUsedProvider;
      const defaultModel = resolveDefaultModelSelection();
      const providerID = defaultModel?.providerID || configState.currentProviderId || lastUsedProvider?.providerID;
      const modelID = defaultModel?.modelID || configState.currentModelId || lastUsedProvider?.modelID;
      const agentName = resolveDefaultAgentName() || configState.currentAgentName || undefined;
      if (!providerID || !modelID) {
        toast.error('No model selected');
        return;
      }

      const variant = resolveDefaultVariant(providerID, modelID);
      try {
        useContextStore.getState().saveSessionModelSelection(sessionId, providerID, modelID);
      } catch {
        // ignore
      }

      if (agentName) {
        try {
          configState.setAgent(agentName);
        } catch {
          // ignore
        }
        try {
          useContextStore.getState().saveSessionAgentSelection(sessionId, agentName);
        } catch {
          // ignore
        }
        try {
          useContextStore.getState().saveAgentModelForSession(sessionId, agentName, providerID, modelID);
        } catch {
          // ignore
        }
        if (variant !== undefined) {
          try {
            configState.setCurrentVariant(variant);
          } catch {
            // ignore
          }
          try {
            useContextStore.getState().saveAgentModelVariantForSession(sessionId, agentName, providerID, modelID, variant);
          } catch {
            // ignore
          }
        }
      }

      const visiblePromptText = 'Review this pull request using the provided PR context: description, comments, files, diff, checks.';
      const instructionsText = `Before reporting issues:
- First identify the PR intent (what it’s trying to achieve) from title/body/diff, then evaluate whether the implementation matches that intent; call out missing pieces, incorrect behavior vs intent, and scope creep.
- Gather any needed repository context (code, config, docs) to validate assumptions.
- No speculation: if something is unclear or cannot be verified, say what’s missing and ask for it instead of guessing.

Output rules:
- Start with a 1-2 sentence summary.
- Provide a single concise PR review comment.
- No emojis. No code snippets. No fenced blocks.
- Short inline code identifiers allowed, but no snippets or fenced blocks.
- Reference evidence with file paths and line ranges (e.g., path/to/file.ts:120-138). If exact lines aren’t available, cite the file and say “approx” + why.
- Keep the entire comment under ~300 words.

Report:
- Must-fix issues (blocking) — brief why and a one-line action each.
- Nice-to-have improvements (optional) — brief why and a one-line action each.

Quality & safety (general):
- Call out correctness risks, edge cases, performance regressions, security/privacy concerns, and backwards-compatibility risks.
- Call out missing tests/verification steps and suggest the minimal validation needed.
- Note readability/maintainability issues when they materially affect future changes.

Applicability (only if relevant):
- If changes affect multiple components/targets/environments (e.g., client/server, OSs, deployments), state what is affected vs not, and why.

Architecture:
- Call out breakages, missing implementations across modules/targets, boundary violations, and cross-cutting concerns (errors, logging/observability, accessibility).

Precedence:
- If local precedent conflicts with best practices, state it and suggest a follow-up task.

Do not implement changes until I confirm; end with a short “Next actions” sentence describing the recommended plan.

Format exactly:
Must-fix:
- <issue> — <brief why> — <file:line-range> — Action: <one-line action>
Nice-to-have:
- <issue> — <brief why> — <file:line-range> — Action: <one-line action>
If no issues, write:
Must-fix:
- None
Nice-to-have:
- None`;
      const contextText = buildPullRequestContextText(prContext);

      void opencodeClient.sendMessage({
        id: sessionId,
        providerID,
        modelID,
        agent: agentName,
        variant,
        text: visiblePromptText,
        additionalParts: [
          { text: instructionsText, synthetic: true },
          { text: contextText, synthetic: true },
        ],
      }).catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        toast.error('Failed to send PR context', { description: message });
      });

      toast.success('Session created from PR');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(createInWorktree ? 'PR worktree failed' : 'Failed to start session', { description: message });
    } finally {
      setStartingNumber(null);
    }
  }, [
    createInWorktree,
    createPrWorktreeSession,
    github,
    includeDiff,
    onOpenChange,
    projectDirectory,
    resolveDefaultAgentName,
    resolveDefaultModelSelection,
    resolveDefaultVariant,
    startingNumber,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[70vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <RiGitPullRequestLine className="h-5 w-5" />
            New Session From GitHub PR
          </DialogTitle>
          <DialogDescription>
            Seeds a new session with hidden PR context (title/body/comments/files/checks).
          </DialogDescription>
        </DialogHeader>

        <div className="relative mt-2">
          <RiSearchLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by title or #123, or paste PR URL"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9 w-full"
          />
        </div>

        <div className="flex-1 overflow-y-auto mt-2">
          {!projectDirectory ? (
            <div className="text-center text-muted-foreground py-8">No active project selected.</div>
          ) : null}

          {!github ? (
            <div className="text-center text-muted-foreground py-8">GitHub runtime API unavailable.</div>
          ) : null}

          {isLoading ? (
            <div className="text-center text-muted-foreground py-8 flex items-center justify-center gap-2">
              <RiLoader4Line className="h-4 w-4 animate-spin" />
              Loading pull requests...
            </div>
          ) : null}

          {connected === false ? (
            <div className="text-center text-muted-foreground py-8 space-y-3">
              <div>GitHub not connected. Connect your GitHub account in settings.</div>
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={openGitHubSettings}>
                  Open settings
                </Button>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="text-center text-muted-foreground py-8 break-words">{error}</div>
          ) : null}

          {directNumber && projectDirectory && github && connected ? (
            <div
              className={cn(
                'group flex items-center gap-2 py-1.5 hover:bg-interactive-hover/30 rounded transition-colors cursor-pointer',
                startingNumber === directNumber && 'bg-interactive-selection/30'
              )}
              onClick={() => void startSession(directNumber)}
            >
              <span className="typography-meta text-muted-foreground w-5 text-right flex-shrink-0">#</span>
              <p className="flex-1 min-w-0 typography-small text-foreground truncate ml-0.5">
                Use PR #{directNumber}
              </p>
              <div className="flex-shrink-0 h-5 flex items-center mr-2">
                {startingNumber === directNumber ? (
                  <RiLoader4Line className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : null}
              </div>
            </div>
          ) : null}

          {filtered.length === 0 && !isLoading && connected && github && projectDirectory ? (
            <div className="text-center text-muted-foreground py-8">{query ? 'No PRs found' : 'No open PRs found'}</div>
          ) : null}

          {filtered.map((pr) => {
            const disabledByWorktree = isPrDisabledForWorktree(pr);

            return (
              <div
                key={pr.number}
                className={cn(
                  'group flex items-start gap-2 py-1.5 rounded transition-colors',
                  startingNumber === pr.number && 'bg-interactive-selection/30',
                  disabledByWorktree
                    ? 'opacity-50 cursor-not-allowed'
                    : 'hover:bg-interactive-hover/30 cursor-pointer'
                )}
                onClick={() => {
                  if (disabledByWorktree) return;
                  void startSession(pr.number);
                }}
              >
                <span className="typography-meta text-muted-foreground w-12 text-right flex-shrink-0 pt-0.5">#{pr.number}</span>
                <div className="flex-1 min-w-0">
                  <p className="typography-small text-foreground truncate ml-0.5">{pr.title}</p>
                  {createInWorktree && disabledByWorktree ? (
                    <p className="typography-micro text-muted-foreground mt-0.5 ml-0.5">
                      PR worktree disabled: branch already exists or is in use ({pr.head})
                    </p>
                  ) : null}
                </div>
                <div className="flex-shrink-0 h-5 flex items-center mr-2 pt-0.5">
                  {startingNumber === pr.number ? (
                    <RiLoader4Line className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : (
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(
                        'hidden group-hover:flex h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground transition-colors',
                        disabledByWorktree && 'pointer-events-none'
                      )}
                      onClick={(e) => e.stopPropagation()}
                      aria-label="Open in GitHub"
                    >
                      <RiExternalLinkLine className="h-4 w-4" />
                    </a>
                  )}
                </div>
              </div>
            );
          })}

          {hasMore && connected && projectDirectory && github ? (
            <div className="py-2 flex justify-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={isLoadingMore || Boolean(startingNumber)}
                className={cn(
                  'typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4',
                  (isLoadingMore || Boolean(startingNumber)) && 'opacity-50 cursor-not-allowed hover:text-muted-foreground'
                )}
              >
                {isLoadingMore ? (
                  <span className="inline-flex items-center gap-2">
                    <RiLoader4Line className="h-4 w-4 animate-spin" />
                    Loading...
                  </span>
                ) : (
                  'Load more'
                )}
              </button>
            </div>
          ) : null}
        </div>

        <div className="mt-4 p-3 bg-muted/30 rounded-lg">
          <p className="typography-meta text-muted-foreground font-medium mb-2">Actions</p>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
              <div
                className="flex items-center gap-2 cursor-pointer"
                role="button"
                tabIndex={0}
                aria-pressed={createInWorktree}
                onClick={() => setCreateInWorktree((v) => !v)}
                onKeyDown={(e) => {
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    setCreateInWorktree((v) => !v);
                  }
                }}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCreateInWorktree((v) => !v);
                  }}
                  aria-label="Toggle worktree"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  {createInWorktree ? (
                    <RiCheckboxLine className="h-4 w-4 text-primary" />
                  ) : (
                    <RiCheckboxBlankLine className="h-4 w-4" />
                  )}
                </button>
                <span className="typography-meta text-muted-foreground">Create in PR worktree</span>
              </div>

              <div
                className="flex items-center gap-2 cursor-pointer"
                role="button"
                tabIndex={0}
                aria-pressed={includeDiff}
                onClick={() => setIncludeDiff((v) => !v)}
                onKeyDown={(e) => {
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    setIncludeDiff((v) => !v);
                  }
                }}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIncludeDiff((v) => !v);
                  }}
                  aria-label="Toggle diff"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  {includeDiff ? (
                    <RiCheckboxLine className="h-4 w-4 text-primary" />
                  ) : (
                    <RiCheckboxBlankLine className="h-4 w-4" />
                  )}
                </button>
                <span className="typography-meta text-muted-foreground">Include full diff</span>
              </div>
            </div>

            <div className="hidden sm:block sm:flex-1" />
            <div className="flex items-center gap-2">
              {repoUrl ? (
                <Button variant="outline" size="sm" asChild>
                  <a href={repoUrl} target="_blank" rel="noopener noreferrer">
                    <RiExternalLinkLine className="size-4" />
                    Open Repo
                  </a>
                </Button>
              ) : null}
              <Button variant="outline" size="sm" onClick={refresh} disabled={isLoading || Boolean(startingNumber)}>
                Refresh
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
