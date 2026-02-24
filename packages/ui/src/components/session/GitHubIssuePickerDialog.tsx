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
  RiGithubLine,
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
import { createWorktreeSessionForNewBranch } from '@/lib/worktreeSessionCreator';
import { generateBranchSlug } from '@/lib/git/branchNameGenerator';
import type { GitHubIssue, GitHubIssueComment, GitHubIssuesListResult, GitHubIssueSummary } from '@/lib/api/types';

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
      setError('No active project');
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
      setError('GitHub runtime API unavailable');
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
  }, [github, githubAuthChecked, githubAuthStatus, projectDirectory]);

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
      toast.error('Failed to load more issues', { description: message });
    } finally {
      setIsLoadingMore(false);
    }
  }, [github, hasMore, isLoading, isLoadingMore, page, projectDirectory]);

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

  const startSession = React.useCallback(async (issueNumber: number) => {
    if (!projectDirectory) {
      toast.error('No active project');
      return;
    }
    if (!github?.issueGet || !github?.issueComments) {
      toast.error('GitHub runtime API unavailable');
      return;
    }
    if (startingIssueNumber) return;
    setStartingIssueNumber(issueNumber);
    try {
      const issueRes = await github.issueGet(projectDirectory, issueNumber);
      if (issueRes.connected === false) {
        toast.error('GitHub not connected');
        return;
      }
      if (!issueRes.repo) {
        toast.error('Repo not resolvable', {
          description: 'origin remote must be a GitHub URL',
        });
        return;
      }
      const issue = issueRes.issue;
      if (!issue) {
        toast.error('Issue not found');
        return;
      }

      const commentsRes = await github.issueComments(projectDirectory, issueNumber);
      if (commentsRes.connected === false) {
        toast.error('GitHub not connected');
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

        const session = await useSessionStore.getState().createSession(sessionTitle, projectDirectory, null);
        if (!session?.id) {
          throw new Error('Failed to create session');
        }
        return session.id;
      })();

      // Ensure worktree-based sessions also get the issue title.
      void useSessionStore.getState().updateSessionTitle(sessionId, sessionTitle).catch(() => undefined);

      try {
        useSessionStore.getState().initializeNewOpenChamberSession(sessionId, useConfigStore.getState().agents);
      } catch {
        // ignore
      }

      // Close modal immediately after session exists (don't wait for message send).
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

      const visiblePromptText = 'Review this issue using the provided issue context: title, body, labels, assignees, comments, metadata.';
      const instructionsText = `Review this issue using the provided issue context.

Process:
- First classify the issue type (bug / feature request / question/support / refactor / ops) and state it as: Type: <one label>.
- Gather any needed repository context (code, config, docs) to validate assumptions.
- After gathering, if anything is still unclear or cannot be verified, do not speculate—state what’s missing and ask targeted questions.

Output rules:
- Compact output; pick ONE template below and omit the others.
- No emojis. No code snippets. No fenced blocks.
- Short inline code identifiers allowed.
- Reference evidence with file paths and line ranges when applicable; if exact lines aren’t available, cite the file and say “approx” + why.
- Keep the entire response under ~300 words.

Templates (choose one):
Bug:
- Summary (1-2 sentences)
- Likely cause (max 2)
- Repro/diagnostics needed (max 3)
- Fix approach (max 4 steps)
- Verification (max 3)

Feature:
- Summary (1-2 sentences)
- Requirements (max 4)
- Unknowns/questions (max 4)
- Proposed plan (max 5 steps)
- Verification (max 3)

Question/Support:
- Summary (1-2 sentences)
- Answer/guidance (max 6 lines)
- Missing info (max 4)

Do not implement changes until I confirm; end with: “Next actions: <1 sentence>”.`;
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
        toast.error('Failed to send issue context', {
          description: message,
        });
      });

      toast.success('Session created from issue');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Failed to start session', { description: message });
    } finally {
      setStartingIssueNumber(null);
    }
  }, [createInWorktree, github, onOpenChange, projectDirectory, resolveDefaultAgentName, resolveDefaultModelSelection, resolveDefaultVariant, startingIssueNumber]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[70vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <RiGithubLine className="h-5 w-5" />
            New Session From GitHub Issue
          </DialogTitle>
          <DialogDescription>
            Seeds a new session with hidden issue context (title/body/labels/comments).
          </DialogDescription>
        </DialogHeader>

        <div className="relative mt-2">
          <RiSearchLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by title or #123, or paste issue URL"
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
              Loading issues...
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
                startingIssueNumber === directNumber && 'bg-interactive-selection/30'
              )}
              onClick={() => void startSession(directNumber)}
            >
              <span className="typography-meta text-muted-foreground w-5 text-right flex-shrink-0">#</span>
              <p className="flex-1 min-w-0 typography-small text-foreground truncate ml-0.5">
                Use issue #{directNumber}
              </p>
              <div className="flex-shrink-0 h-5 flex items-center mr-2">
                {startingIssueNumber === directNumber ? (
                  <RiLoader4Line className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : null}
              </div>
            </div>
          ) : null}

          {filtered.length === 0 && !isLoading && connected && github && projectDirectory ? (
            <div className="text-center text-muted-foreground py-8">{query ? 'No issues found' : 'No open issues found'}</div>
          ) : null}

          {filtered.map((issue) => (
            <div
              key={issue.number}
              className={cn(
                'group flex items-center gap-2 py-1.5 hover:bg-interactive-hover/30 rounded transition-colors cursor-pointer',
                startingIssueNumber === issue.number && 'bg-interactive-selection/30'
              )}
              onClick={() => void startSession(issue.number)}
            >
              <span className="typography-meta text-muted-foreground w-12 text-right flex-shrink-0">
                #{issue.number}
              </span>
              <p className="flex-1 min-w-0 typography-small text-foreground truncate ml-0.5">
                {issue.title}
              </p>

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
                    aria-label="Open in GitHub"
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
                aria-label="Toggle worktree"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {createInWorktree ? (
                  <RiCheckboxLine className="h-4 w-4 text-primary" />
                ) : (
                  <RiCheckboxBlankLine className="h-4 w-4" />
                )}
              </button>
              <span className="typography-meta text-muted-foreground">Create in worktree</span>
              <span className="typography-meta text-muted-foreground/70 hidden sm:inline">(issue-&lt;number&gt;-&lt;slug&gt;)</span>
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
              <Button variant="outline" size="sm" onClick={refresh} disabled={isLoading || Boolean(startingIssueNumber)}>
                Refresh
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
