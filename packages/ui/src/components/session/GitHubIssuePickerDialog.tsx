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
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { toast } from '@/components/ui';
import {
  RiCheckboxBlankLine,
  RiCheckboxLine,
  RiExternalLinkLine,
  RiGithubLine,
  RiLoader4Line,
  RiSearchLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import * as sessionActions from '@/sync/session-actions';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextStore } from '@/stores/contextStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { opencodeClient } from '@/lib/opencode/client';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { createWorktreeSessionForNewBranch } from '@/lib/worktreeSessionCreator';
import { generateBranchSlug } from '@/lib/git/branchNameGenerator';
import type { GitHubIssue, GitHubIssueComment, GitHubIssuesListResult, GitHubIssueSummary, GitHubRepoSelector } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

const parseIssueNumber = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/\/issues\/(\d+)(?:\b|\/|$)/i);
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

const buildIssueContextText = (args: {
  repo: GitHubIssuesListResult['repo'] | undefined;
  issue: GitHubIssue;
  comments: GitHubIssueComment[];
}) => {
  const payload = {
    repo: args.repo ?? null,
    issue: args.issue,
    comments: args.comments,
  };
  return `GitHub issue context (JSON)\n${JSON.stringify(payload, null, 2)}`;
};

export function GitHubIssuePickerDialog({
  open,
  onOpenChange,
  mode = 'createSession',
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode?: 'createSession' | 'select';
  onSelect?: (issue: { number: number; title: string; url: string; contextText: string; author?: { login: string; avatarUrl?: string } }) => void;
}) {
  const { t } = useI18n();
  const { github } = useRuntimeAPIs();
  const githubAuthStatus = useGitHubAuthStore((state) => state.status);
  const githubAuthChecked = useGitHubAuthStore((state) => state.hasChecked);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const isMobile = useUIStore((state) => state.isMobile);
  const activeProject = useProjectsStore((state) => state.getActiveProject());
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);

  const projectDirectory = React.useMemo(() => {
    return activeProject?.path?.trim() || currentDirectory?.trim() || null;
  }, [activeProject?.path, currentDirectory]);

  const [query, setQuery] = React.useState('');
  const [createInWorktree, setCreateInWorktree] = React.useState(false);
  const [result, setResult] = React.useState<GitHubIssuesListResult | null>(null);
  const [issues, setIssues] = React.useState<GitHubIssueSummary[]>([]);
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const [startingIssueNumber, setStartingIssueNumber] = React.useState<number | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!projectDirectory) {
      setResult(null);
      setError(t('session.githubIssuePicker.error.noActiveProject'));
      return;
    }
    if (githubAuthChecked && githubAuthStatus?.connected === false) {
      setResult({ connected: false });
      setIssues([]);
      setHasMore(false);
      setPage(1);
      setError(null);
      return;
    }
    if (!github?.issuesList) {
      setResult(null);
      setError(t('session.githubIssuePicker.error.runtimeUnavailable'));
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const next = await github.issuesList(projectDirectory, { page: 1 });
      setResult(next);
      setIssues(next.issues ?? []);
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
  }, [github, githubAuthChecked, githubAuthStatus, projectDirectory, t]);

  const loadMore = React.useCallback(async () => {
    if (!projectDirectory) return;
    if (!github?.issuesList) return;
    if (isLoadingMore || isLoading) return;
    if (!hasMore) return;

    setIsLoadingMore(true);
    try {
      const nextPage = page + 1;
      const next = await github.issuesList(projectDirectory, { page: nextPage });
      setResult(next);
      setIssues((prev) => [...prev, ...(next.issues ?? [])]);
      setPage(next.page ?? nextPage);
      setHasMore(Boolean(next.hasMore));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('session.githubIssuePicker.toast.loadMoreFailed'), { description: message });
    } finally {
      setIsLoadingMore(false);
    }
  }, [github, hasMore, isLoading, isLoadingMore, page, projectDirectory, t]);

  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setCreateInWorktree(false);
      setStartingIssueNumber(null);
      setError(null);
      setResult(null);
      setIssues([]);
      setPage(1);
      setHasMore(false);
      setIsLoading(false);
      return;
    }
    void refresh();
  }, [open, refresh]);

  React.useEffect(() => {
    if (!open) return;
    if (githubAuthChecked && githubAuthStatus?.connected === false) {
      setResult({ connected: false });
      setIssues([]);
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
    if (!q) return issues;
    return issues.filter((issue) => {
      if (String(issue.number) === q.replace(/^#/, '')) return true;
      return issue.title.toLowerCase().includes(q);
    });
  }, [issues, query]);

  const directNumber = React.useMemo(() => parseIssueNumber(query), [query]);

  const resolveDefaultAgentName = React.useCallback((): string | undefined => {
    const configState = useConfigStore.getState();
    const visibleAgents = configState.getVisibleAgents();

    if (configState.settingsDefaultAgent) {
      const settingsAgent = visibleAgents.find((a) => a.name === configState.settingsDefaultAgent);
      if (settingsAgent) {
        return settingsAgent.name;
      }
    }

    return (
      visibleAgents.find((agent) => agent.name === 'build')?.name ||
      visibleAgents[0]?.name
    );
  }, []);

  const resolveDefaultModelSelection = React.useCallback((): { providerID: string; modelID: string } | null => {
    const configState = useConfigStore.getState();
    const settingsDefaultModel = configState.settingsDefaultModel;
    if (!settingsDefaultModel) {
      return null;
    }

    const parts = settingsDefaultModel.split('/');
    if (parts.length !== 2) {
      return null;
    }
    const [providerID, modelID] = parts;
    if (!providerID || !modelID) {
      return null;
    }

    const modelMetadata = configState.getModelMetadata(providerID, modelID);
    if (!modelMetadata) {
      return null;
    }

    return { providerID, modelID };
  }, []);

  const resolveDefaultVariant = React.useCallback((providerID: string, modelID: string): string | undefined => {
    const configState = useConfigStore.getState();
    const settingsDefaultVariant = configState.settingsDefaultVariant;
    if (!settingsDefaultVariant) {
      return undefined;
    }

    const provider = configState.providers.find((p) => p.id === providerID);
    const model = provider?.models.find((m: Record<string, unknown>) => (m as { id?: string }).id === modelID) as
      | { variants?: Record<string, unknown> }
      | undefined;
    const variants = model?.variants;
    if (!variants) {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(variants, settingsDefaultVariant)) {
      return undefined;
    }
    return settingsDefaultVariant;
  }, []);

  const startSession = React.useCallback(async (issueNumber: number, sourceRepo?: GitHubRepoSelector | null) => {
    if (mode === 'select') {
      // In select mode, fetch full issue details and return via onSelect
      if (!projectDirectory) {
        toast.error(t('session.githubIssuePicker.error.noActiveProject'));
        return;
      }
      if (!github?.issueGet || !github?.issueComments) {
        toast.error(t('session.githubIssuePicker.error.runtimeUnavailable'));
        return;
      }
      if (startingIssueNumber) return;
      setStartingIssueNumber(issueNumber);
      try {
        const issueRes = await github.issueGet(projectDirectory, issueNumber, { sourceRepo });
        if (issueRes.connected === false) {
          toast.error(t('session.githubIssuePicker.error.notConnected'));
          return;
        }
        if (!issueRes.repo) {
          toast.error(t('session.githubIssuePicker.error.repoNotResolvable'), {
            description: t('session.githubIssuePicker.error.repoMustBeGithub'),
          });
          return;
        }
        const issue = issueRes.issue;
        if (!issue) {
          toast.error(t('session.githubIssuePicker.error.issueNotFound'));
          return;
        }

        const commentsRes = await github.issueComments(projectDirectory, issueNumber, { sourceRepo });
        if (commentsRes.connected === false) {
          toast.error(t('session.githubIssuePicker.error.notConnected'));
          return;
        }
        const comments = commentsRes.comments ?? [];

        // Build full context text like in createSession mode
        const contextText = buildIssueContextText({ repo: issueRes.repo, issue, comments });

        if (onSelect) {
          onSelect({ 
            number: issue.number, 
            title: issue.title, 
            url: issue.url,
            contextText,
            author: issue.author ? {
              login: issue.author.login,
              avatarUrl: issue.author.avatarUrl,
            } : undefined,
          });
        }
        onOpenChange(false);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        toast.error(t('session.githubIssuePicker.toast.loadIssueDetailsFailed'), { description: message });
      } finally {
        setStartingIssueNumber(null);
      }
      return;
    }

    if (!projectDirectory) {
      toast.error(t('session.githubIssuePicker.error.noActiveProject'));
      return;
    }
    if (!github?.issueGet || !github?.issueComments) {
      toast.error(t('session.githubIssuePicker.error.runtimeUnavailable'));
      return;
    }
    if (startingIssueNumber) return;
    setStartingIssueNumber(issueNumber);
    try {
      const issueRes = await github.issueGet(projectDirectory, issueNumber, { sourceRepo });
      if (issueRes.connected === false) {
        toast.error(t('session.githubIssuePicker.error.notConnected'));
        return;
      }
      if (!issueRes.repo) {
        toast.error(t('session.githubIssuePicker.error.repoNotResolvable'), {
          description: t('session.githubIssuePicker.error.repoMustBeGithub'),
        });
        return;
      }
      const issue = issueRes.issue;
      if (!issue) {
        toast.error(t('session.githubIssuePicker.error.issueNotFound'));
        return;
      }

      const commentsRes = await github.issueComments(projectDirectory, issueNumber, { sourceRepo });
      if (commentsRes.connected === false) {
        toast.error(t('session.githubIssuePicker.error.notConnected'));
        return;
      }
      const comments = commentsRes.comments ?? [];

      const sessionTitle = `#${issue.number} ${issue.title}`.trim();

      const sessionId = await (async () => {
        if (createInWorktree) {
          const preferred = `issue-${issue.number}-${generateBranchSlug()}`;
          const created = await createWorktreeSessionForNewBranch(
            projectDirectory,
            preferred
          );
          if (!created?.id) {
            throw new Error('Failed to create worktree session');
          }
          return created.id;
        }

        const session = await sessionActions.createSession(sessionTitle, projectDirectory, null);
        if (!session?.id) {
          throw new Error('Failed to create session');
        }
        return session.id;
      })();

      // Ensure worktree-based sessions also get the issue title.
      void sessionActions.updateSessionTitle(sessionId, sessionTitle).catch(() => undefined);

      try {
        useSessionUIStore.getState().initializeNewOpenChamberSession(sessionId, useConfigStore.getState().agents);
      } catch {
        // ignore
      }

      // Close modal immediately after session exists (don't wait for message send).
      onOpenChange(false);

      const configState = useConfigStore.getState();
      const lastUsedProvider = useSelectionStore.getState().lastUsedProvider;

      const defaultModel = resolveDefaultModelSelection();
      const providerID = defaultModel?.providerID || configState.currentProviderId || lastUsedProvider?.providerID;
      const modelID = defaultModel?.modelID || configState.currentModelId || lastUsedProvider?.modelID;
      const agentName = resolveDefaultAgentName() || configState.currentAgentName || undefined;
      if (!providerID || !modelID) {
        toast.error(t('session.githubIssuePicker.error.noModelSelected'));
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

      const visiblePromptText = await renderMagicPrompt('github.issue.review.visible', {
        issue_number: String(issue.number),
      });
      const instructionsText = await renderMagicPrompt('github.issue.review.instructions');
      const contextText = buildIssueContextText({ repo: issueRes.repo, issue, comments });

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
        toast.error(t('session.githubIssuePicker.toast.sendContextFailed'), {
          description: message,
        });
      });

      toast.success(t('session.githubIssuePicker.toast.sessionCreated'));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('session.githubIssuePicker.toast.startSessionFailed'), { description: message });
    } finally {
      setStartingIssueNumber(null);
    }
  }, [createInWorktree, github, mode, onOpenChange, onSelect, projectDirectory, resolveDefaultAgentName, resolveDefaultModelSelection, resolveDefaultVariant, startingIssueNumber, t]);

  const title = mode === 'select' ? t('session.githubIssuePicker.title.select') : t('session.githubIssuePicker.title.createSession');
  const description = mode === 'select'
    ? t('session.githubIssuePicker.description.select')
    : t('session.githubIssuePicker.description.createSession');

  const content = (
    <>
      <div className="relative mt-2">
        <RiSearchLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('session.githubIssuePicker.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9 w-full"
        />
      </div>

      <div className={cn(isMobile ? 'min-h-0 mt-2' : 'flex-1 overflow-y-auto mt-2')}>
          {!projectDirectory ? (
            <div className="text-center text-muted-foreground py-8">{t('session.githubIssuePicker.empty.noActiveProject')}</div>
          ) : null}

          {!github ? (
            <div className="text-center text-muted-foreground py-8">{t('session.githubIssuePicker.empty.runtimeUnavailable')}</div>
          ) : null}

          {isLoading ? (
            <div className="text-center text-muted-foreground py-8 flex items-center justify-center gap-2">
              <RiLoader4Line className="h-4 w-4 animate-spin" />
              {t('session.githubIssuePicker.loading.issues')}
            </div>
          ) : null}

          {connected === false ? (
            <div className="text-center text-muted-foreground py-8 space-y-3">
              <div>{t('session.githubIssuePicker.empty.notConnected')}</div>
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={openGitHubSettings}>
                  {t('session.githubIssuePicker.actions.openSettings')}
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
                startingIssueNumber === directNumber && 'bg-interactive-selection/30'
              )}
              onClick={() => void startSession(directNumber)}
            >
              <span className="typography-meta text-muted-foreground w-5 text-right flex-shrink-0">#</span>
              <p className="flex-1 min-w-0 typography-small text-foreground truncate ml-0.5">
                {t('session.githubIssuePicker.actions.useIssue', { number: directNumber })}
              </p>
              <div className="flex-shrink-0 h-5 flex items-center mr-2">
                {startingIssueNumber === directNumber ? (
                  <RiLoader4Line className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : null}
              </div>
            </div>
          ) : null}

          {filtered.length === 0 && !isLoading && connected && github && projectDirectory ? (
            <div className="text-center text-muted-foreground py-8">{query ? t('session.githubIssuePicker.empty.noIssuesFound') : t('session.githubIssuePicker.empty.noOpenIssuesFound')}</div>
          ) : null}

          {filtered.map((issue) => (
            <div
              key={`${issue.sourceRepo?.owner ?? ''}-${issue.sourceRepo?.repo ?? ''}-${issue.number}`}
              className={cn(
                'group flex items-center gap-2 py-1.5 hover:bg-interactive-hover/30 rounded transition-colors cursor-pointer',
                startingIssueNumber === issue.number && 'bg-interactive-selection/30'
              )}
              onClick={() => void startSession(issue.number, issue.sourceRepo)}
            >
              <span className="typography-meta text-muted-foreground w-12 text-right flex-shrink-0">
                #{issue.number}
              </span>
              <div className="flex-1 min-w-0 ml-0.5">
                <p className="typography-small text-foreground truncate">
                  {issue.title}
                </p>
                {issue.sourceRepo?.source === 'upstream' ? (
                  <span className="typography-micro px-1 py-0.5 rounded bg-status-info/10 text-status-info mt-0.5 inline-block">
                    {issue.sourceRepo.owner}/{issue.sourceRepo.repo}
                  </span>
                ) : null}
              </div>

              <div className="flex-shrink-0 h-5 flex items-center mr-2">
                {startingIssueNumber === issue.number ? (
                  <RiLoader4Line className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <a
                    href={issue.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hidden group-hover:flex h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                    onClick={(e) => e.stopPropagation()}
                    aria-label={t('session.githubIssuePicker.actions.openInGitHubAria')}
                  >
                    <RiExternalLinkLine className="h-4 w-4" />
                  </a>
                )}
              </div>
            </div>
          ))}

          {hasMore && connected && projectDirectory && github ? (
            <div className="py-2 flex justify-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={isLoadingMore || Boolean(startingIssueNumber)}
                className={cn(
                  'typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4',
                  (isLoadingMore || Boolean(startingIssueNumber)) && 'opacity-50 cursor-not-allowed hover:text-muted-foreground'
                )}
              >
                {isLoadingMore ? (
                  <span className="inline-flex items-center gap-2">
                    <RiLoader4Line className="h-4 w-4 animate-spin" />
                    {t('session.githubIssuePicker.loading.more')}
                  </span>
                ) : (
                  t('session.githubIssuePicker.actions.loadMore')
                )}
              </button>
            </div>
          ) : null}
      </div>

      {mode !== 'select' && (
        <div className="mt-4 p-3 bg-muted/30 rounded-lg">
          <p className="typography-meta text-muted-foreground font-medium mb-2">{t('session.githubIssuePicker.actions.sectionTitle')}</p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-2">
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
                aria-label={t('session.githubIssuePicker.actions.toggleWorktreeAria')}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {createInWorktree ? (
                  <RiCheckboxLine className="h-4 w-4 text-primary" />
                ) : (
                  <RiCheckboxBlankLine className="h-4 w-4" />
                )}
              </button>
              <span className="typography-meta text-muted-foreground">{t('session.githubIssuePicker.actions.createInWorktree')}</span>
              <span className="typography-meta text-muted-foreground/70 hidden sm:inline">(issue-&lt;number&gt;-&lt;slug&gt;)</span>
            </div>
            <div className="hidden sm:block sm:flex-1" />
            <div className="flex items-center gap-2">
              {repoUrl ? (
                <Button variant="outline" size="sm" asChild>
                  <a href={repoUrl} target="_blank" rel="noopener noreferrer">
                    <RiExternalLinkLine className="size-4" />
                    {t('session.githubIssuePicker.actions.openRepo')}
                  </a>
                </Button>
              ) : null}
              <Button variant="outline" size="sm" onClick={refresh} disabled={isLoading || Boolean(startingIssueNumber)}>
                {t('session.githubIssuePicker.actions.refresh')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel
        open={open}
        title={title}
        onClose={() => onOpenChange(false)}
        renderHeader={(closeButton) => (
          <div className="flex flex-col gap-1.5 px-3 py-2 border-b border-border/40">
            <div className="flex items-center justify-between">
              <h2 className="typography-ui-label font-semibold text-foreground">{title}</h2>
              {closeButton}
            </div>
            <p className="typography-small text-muted-foreground">{description}</p>
          </div>
        )}
      >
        {content}
      </MobileOverlayPanel>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[70vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <RiGithubLine className="h-5 w-5" />
            {title}
          </DialogTitle>
          <DialogDescription>
            {description}
          </DialogDescription>
        </DialogHeader>

        {content}
      </DialogContent>
    </Dialog>
  );
}
