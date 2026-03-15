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
import { Checkbox } from '@/components/ui/checkbox';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { toast } from '@/components/ui';
import {
  RiGithubLine,
  RiLoader4Line,
  RiSearchLine,
  RiExternalLinkLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useLanguage } from '@/hooks/useLanguage';
import type { GitHubPullRequestContextResult, GitHubPullRequestSummary, GitHubPullRequestsListResult } from '@/lib/api/types';

const parsePrNumber = (value: string): number | null => {
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

const PR_REVIEW_INSTRUCTIONS = `Before reporting issues:
- First identify the PR intent (what it's trying to achieve) from title/body/diff, then evaluate whether the implementation matches that intent; call out missing pieces, incorrect behavior vs intent, and scope creep.
- Gather any needed repository context (code, config, docs) to validate assumptions.
- No speculation: if something is unclear or cannot be verified, say what's missing and ask for it instead of guessing.

Output rules:
- Start with a 1-2 sentence summary.
- Provide a single concise PR review comment.
- No emojis. No code snippets. No fenced blocks.
- Short inline code identifiers allowed, but no snippets or fenced blocks.
- Reference evidence with file paths and line ranges (e.g., path/to/file.ts:120-138). If exact lines aren't available, cite the file and say "approx" + why.
- Keep the entire comment under ~300 words.

Report:
- Must-fix issues (blocking)-brief why and a one-line action each.
- Nice-to-have improvements (optional)-brief why and a one-line action each.

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

Do not implement changes until I confirm; end with a short "Next actions" sentence describing the recommended plan.

Format exactly:
Must-fix:
- <issue> - <brief why> - <file:line-range> - Action: <one-line action>
Nice-to-have:
- <issue> - <brief why> - <file:line-range> - Action: <one-line action>
If no issues, write:
Must-fix:
- None
Nice-to-have:
- None`;

export function GitHubPrPickerDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect?: (pr: {
    number: number;
    title: string;
    url: string;
    head: string;
    base: string;
    includeDiff: boolean;
    instructionsText: string;
    contextText: string;
    author?: { login: string; avatarUrl?: string };
  }) => void;
}) {
  const { t } = useLanguage();
  const { github } = useRuntimeAPIs();
  const githubAuthStatus = useGitHubAuthStore((state) => state.status);
  const githubAuthChecked = useGitHubAuthStore((state) => state.hasChecked);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const isMobile = useUIStore((state) => state.isMobile);
  const activeProject = useProjectsStore((state) => state.getActiveProject());

  const projectDirectory = activeProject?.path ?? null;

  const [query, setQuery] = React.useState('');
  const [includeDiff, setIncludeDiff] = React.useState(false);
  const [result, setResult] = React.useState<GitHubPullRequestsListResult | null>(null);
  const [prs, setPrs] = React.useState<GitHubPullRequestSummary[]>([]);
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const [loadingPrNumber, setLoadingPrNumber] = React.useState<number | null>(null);
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
      toast.error(t('githubPullRequestPickerDialog.failedToLoadMorePrs'), { description: message });
    } finally {
      setIsLoadingMore(false);
    }
  }, [github, hasMore, isLoading, isLoadingMore, page, projectDirectory, t]);

  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setIncludeDiff(false);
      setLoadingPrNumber(null);
      setError(null);
      setResult(null);
      setPrs([]);
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
      setPrs([]);
      setHasMore(false);
      setPage(1);
      setError(null);
    }
  }, [githubAuthChecked, githubAuthStatus, open]);

  const connected = githubAuthChecked ? result?.connected !== false : true;

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

  const directNumber = React.useMemo(() => parsePrNumber(query), [query]);

  const attachPr = React.useCallback(async (prNumber: number) => {
    if (!projectDirectory) {
      toast.error(t('githubPullRequestPickerDialog.noActiveProject'));
      return;
    }
    if (!github?.prContext) {
      toast.error(t('githubPullRequestPickerDialog.runtimeApiUnavailable'));
      return;
    }
    if (loadingPrNumber) return;

    setLoadingPrNumber(prNumber);
    try {
      const context = await github.prContext(projectDirectory, prNumber, {
        includeDiff,
        includeCheckDetails: false,
      });

      if (context.connected === false) {
        toast.error(t('githubPullRequestPickerDialog.notConnected'));
        return;
      }

      if (!context.pr) {
        toast.error(t('githubPullRequestPickerDialog.prNotFound'));
        return;
      }

      if (!context.repo) {
        toast.error(t('githubPullRequestPickerDialog.repoNotResolvable'), {
          description: t('githubPullRequestPickerDialog.originRemoteMustBeGithubUrl'),
        });
        return;
      }

      if (onSelect) {
        onSelect({
          number: context.pr.number,
          title: context.pr.title,
          url: context.pr.url,
          head: context.pr.head,
          base: context.pr.base,
          includeDiff,
          instructionsText: PR_REVIEW_INSTRUCTIONS,
          contextText: buildPullRequestContextText(context),
          author: context.pr.author
            ? {
              login: context.pr.author.login,
              avatarUrl: context.pr.author.avatarUrl,
            }
            : undefined,
        });
      }
      onOpenChange(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('githubPullRequestPickerDialog.failedToLoadPrDetails'), { description: message });
    } finally {
      setLoadingPrNumber(null);
    }
  }, [github, includeDiff, loadingPrNumber, onOpenChange, onSelect, projectDirectory, t]);

  const title = t('githubPullRequestPickerDialog.linkTitle');
  const description = t('githubPullRequestPickerDialog.linkDescription');

  const content = (
    <>
      <div className="mt-2 flex items-center gap-3">
        <div className="relative flex-1 min-w-0">
          <RiSearchLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('githubPullRequestPickerDialog.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9 w-full"
          />
        </div>
        <button
          type="button"
          onClick={() => setIncludeDiff((prev) => !prev)}
          className="h-9 shrink-0 flex items-center gap-1 text-left"
          aria-pressed={includeDiff}
          aria-label={t('githubPullRequestPickerDialog.includePrDiffInAttachedContext')}
        >
          <Checkbox
            checked={includeDiff}
            onChange={(checked) => setIncludeDiff(checked)}
            ariaLabel={t('githubPullRequestPickerDialog.includePrDiffInAttachedContext')}
            className="size-6"
            iconClassName="size-5"
          />
          <span className="typography-small text-muted-foreground whitespace-nowrap">{t('githubIntegrationDialog.includePrDiff')}</span>
        </button>
      </div>

      <div className={cn(isMobile ? 'min-h-0' : 'flex-1 overflow-y-auto')}>
          {!projectDirectory ? (
            <div className="text-center text-muted-foreground py-8">{t('githubIssuePickerDialog.noActiveProjectSelected')}</div>
          ) : null}

          {!github ? (
            <div className="text-center text-muted-foreground py-8">{t('githubIssuePickerDialog.runtimeApiUnavailable')}</div>
          ) : null}

          {isLoading ? (
            <div className="text-center text-muted-foreground py-8 flex items-center justify-center gap-2">
              <RiLoader4Line className="h-4 w-4 animate-spin" />
              {t('githubPullRequestPickerDialog.loadingPullRequests')}
            </div>
          ) : null}

          {connected === false ? (
            <div className="text-center text-muted-foreground py-8 space-y-3">
              <div>{t('githubIssuePickerDialog.notConnected')}</div>
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={openGitHubSettings}>
                  {t('commandPalette.openSettings')}
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
                loadingPrNumber === directNumber && 'bg-interactive-selection/30'
              )}
              onClick={() => void attachPr(directNumber)}
            >
              <span className="typography-meta text-muted-foreground w-5 text-right flex-shrink-0">#</span>
              <p className="flex-1 min-w-0 typography-small text-foreground truncate ml-0.5">
                {t('githubPullRequestPickerDialog.usePrNumber', { number: directNumber })}
              </p>
              <div className="flex-shrink-0 h-5 flex items-center mr-2">
                {loadingPrNumber === directNumber ? (
                  <RiLoader4Line className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : null}
              </div>
            </div>
          ) : null}

          {filtered.length === 0 && !isLoading && connected && github && projectDirectory ? (
            <div className="text-center text-muted-foreground py-8">
              {query ? t('githubPullRequestPickerDialog.noPrsFound') : t('githubPullRequestPickerDialog.noOpenPrsFound')}
            </div>
          ) : null}

          {filtered.map((pr) => (
            <div
              key={pr.number}
              className={cn(
                'group flex items-center gap-2 py-1.5 hover:bg-interactive-hover/30 rounded transition-colors cursor-pointer',
                loadingPrNumber === pr.number && 'bg-interactive-selection/30'
              )}
              onClick={() => void attachPr(pr.number)}
            >
              <div className="flex-1 min-w-0 ml-0.5">
                <p className="typography-small text-foreground truncate">
                  <span className="text-muted-foreground mr-1">#{pr.number}</span>
                  {pr.title}
                </p>
                <p className="typography-meta text-muted-foreground truncate">{pr.head} → {pr.base}</p>
              </div>

              <div className="flex-shrink-0 h-5 flex items-center mr-2">
                {loadingPrNumber === pr.number ? (
                  <RiLoader4Line className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hidden group-hover:flex h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                    onClick={(e) => e.stopPropagation()}
                    aria-label={t('githubIssuePickerDialog.openInGithub')}
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
                disabled={isLoadingMore || Boolean(loadingPrNumber)}
                className={cn(
                  'typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4',
                  (isLoadingMore || Boolean(loadingPrNumber)) && 'opacity-50 cursor-not-allowed hover:text-muted-foreground'
                )}
              >
                {isLoadingMore ? (
                  <span className="inline-flex items-center gap-2">
                    <RiLoader4Line className="h-4 w-4 animate-spin" />
                    {t('githubPullRequestPickerDialog.loading')}
                  </span>
                ) : (
                  t('githubPullRequestPickerDialog.loadMore')
                )}
              </button>
            </div>
          ) : null}
      </div>
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
