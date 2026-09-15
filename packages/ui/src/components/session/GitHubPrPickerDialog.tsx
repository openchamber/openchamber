import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
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
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { useDeviceInfo } from '@/lib/device';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { getGitHubApiErrorCode } from '@/lib/api/github-errors';
import type { GitHubPullRequestContextResult, GitHubPullRequestSummary, GitHubPullRequestsListResult, GitHubRepoSelector } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

const buildPullRequestContextText = (payload: GitHubPullRequestContextResult) => {
  return `GitHub pull request context (JSON)\n${JSON.stringify(payload, null, 2)}`;
};

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
  const { t } = useI18n();
  const { github } = useRuntimeAPIs();
  const githubAuthStatus = useGitHubAuthStore((state) => state.status);
  const githubAuthChecked = useGitHubAuthStore((state) => state.hasChecked);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const isMobile = useUIStore((state) => state.isMobile);
  const { isTablet } = useDeviceInfo();
  const alwaysShowActions = isMobile || isTablet;
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

  // One owner for "which query owns the in-flight data": every page-1 load
  // bumps the generation, page-2 loads capture it and drop their result when a
  // newer page-1 load has taken over.
  const requestGenerationRef = React.useRef(0);
  const loadMoreControllerRef = React.useRef<AbortController | null>(null);

  const debouncedQuery = useDebouncedValue(query, 350);
  const isTextSearch = debouncedQuery.trim().length > 0;

  const describeError = React.useCallback((e: unknown): string => {
    const code = getGitHubApiErrorCode(e);
    if (code === 'search_timeout') return t('session.githubPrPicker.error.searchTimedOut');
    if (code === 'not_found') return t('session.githubPrPicker.error.prNotFound');
    if (code === 'repo_unavailable') return t('session.githubPrPicker.error.repoNotResolvable');
    return e instanceof Error ? e.message : String(e);
  }, [t]);

  const refresh = React.useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    if (!projectDirectory) {
      setResult(null);
      setError(t('session.githubPrPicker.error.noActiveProject'));
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
      setError(t('session.githubPrPicker.error.runtimeUnavailable'));
      return;
    }

    const generation = ++requestGenerationRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const next = await github.prsList(projectDirectory, {
        page: 1,
        query: debouncedQuery.trim() || undefined,
        signal,
      });
      if (signal?.aborted || generation !== requestGenerationRef.current) return;
      setResult(next);
      setPrs(next.prs ?? []);
      setPage(next.page ?? 1);
      setHasMore(Boolean(next.hasMore));
    } catch (e) {
      if (signal?.aborted || generation !== requestGenerationRef.current) return;
      setPrs([]);
      setPage(1);
      setHasMore(false);
      setError(describeError(e));
    } finally {
      if (!signal?.aborted && generation === requestGenerationRef.current) setIsLoading(false);
    }
  }, [debouncedQuery, describeError, github, githubAuthChecked, githubAuthStatus, projectDirectory, t]);

  React.useEffect(() => {
    if (!open || !projectDirectory) return;
    if (githubAuthChecked && githubAuthStatus?.connected === false) return;
    if (!github?.prsList) return;

    const controller = new AbortController();
    void refresh(controller.signal);

    return () => {
      controller.abort();
      loadMoreControllerRef.current?.abort();
      loadMoreControllerRef.current = null;
      setIsLoading(false);
    };
  }, [open, projectDirectory, github, githubAuthChecked, githubAuthStatus, refresh]);

  const loadMore = React.useCallback(async () => {
    if (!projectDirectory) return;
    if (!github?.prsList) return;
    if (isLoadingMore || isLoading) return;
    if (!hasMore) return;

    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;
    setIsLoadingMore(true);
    try {
      const nextPage = page + 1;
      const next = isTextSearch
        ? await github.prsList(projectDirectory, { page: nextPage, query: debouncedQuery.trim(), signal: controller.signal })
        : await github.prsList(projectDirectory, { page: nextPage, signal: controller.signal });
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
      setResult(next);
      setPrs((prev) => [...prev, ...(next.prs ?? [])]);
      setPage(next.page ?? nextPage);
      setHasMore(Boolean(next.hasMore));
    } catch (e) {
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
      const message = getGitHubApiErrorCode(e) === 'search_timeout'
        ? t('session.githubPrPicker.error.searchTimedOut')
        : e instanceof Error ? e.message : String(e);
      toast.error(t('session.githubPrPicker.toast.loadMoreFailed'), { description: message });
    } finally {
      if (loadMoreControllerRef.current === controller) loadMoreControllerRef.current = null;
      setIsLoadingMore(false);
    }
  }, [github, hasMore, isLoading, isLoadingMore, isTextSearch, debouncedQuery, page, projectDirectory, t]);

  React.useEffect(() => {
    if (open) return;
    setQuery('');
    setIncludeDiff(false);
    setLoadingPrNumber(null);
    setError(null);
    setResult(null);
    setPrs([]);
    setPage(1);
    setHasMore(false);
    setIsLoading(false);
  }, [open]);

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
    setSettingsPage('integrations');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage]);

  const attachPr = React.useCallback(async (prNumber: number, sourceRepo?: GitHubRepoSelector | null) => {
    if (!projectDirectory) {
      toast.error(t('session.githubPrPicker.error.noActiveProject'));
      return;
    }
    if (!github?.prContext) {
      toast.error(t('session.githubPrPicker.error.runtimeUnavailable'));
      return;
    }
    if (loadingPrNumber) return;

    setLoadingPrNumber(prNumber);
    try {
      const context = await github.prContext(projectDirectory, prNumber, {
        includeDiff,
        includeCheckDetails: false,
        sourceRepo,
      });

      if (context.connected === false) {
        toast.error(t('session.githubPrPicker.error.notConnected'));
        return;
      }

      if (!context.pr) {
        toast.error(t('session.githubPrPicker.error.prNotFound'));
        return;
      }

      if (!context.repo) {
        toast.error(t('session.githubPrPicker.error.repoNotResolvable'), {
          description: t('session.githubPrPicker.error.repoMustBeGithub'),
        });
        return;
      }

      if (onSelect) {
        const instructionsText = await renderMagicPrompt('github.pr.review.instructions');
        onSelect({
          number: context.pr.number,
          title: context.pr.title,
          url: context.pr.url,
          head: context.pr.head,
          base: context.pr.base,
          includeDiff,
          instructionsText,
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
      toast.error(t('session.githubPrPicker.toast.loadDetailsFailed'), { description: message });
    } finally {
      setLoadingPrNumber(null);
    }
  }, [github, includeDiff, loadingPrNumber, onOpenChange, onSelect, projectDirectory, t]);

  const title = t('session.githubPrPicker.title');
  const description = t('session.githubPrPicker.description');

  const content = (
    <>
      <div className="mt-2 flex items-center gap-3">
        <div className="relative flex-1 min-w-0">
          <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('session.githubPrPicker.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9 w-full"
          />
        </div>
        <button
          type="button"
          onClick={() => setIncludeDiff((prev) => !prev)}
          className="h-9 shrink-0 flex items-center gap-2 text-left"
          aria-pressed={includeDiff}
          aria-label={t('session.githubPrPicker.includeDiffAria')}
        >
          <span onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={includeDiff}
              onChange={(checked) => setIncludeDiff(checked)}
              ariaLabel={t('session.githubPrPicker.includeDiffAria')}
            />
          </span>
          <span className="typography-small text-muted-foreground whitespace-nowrap">{t('session.githubPrPicker.includeDiff')}</span>
        </button>
      </div>

      <ScrollableOverlay outerClassName={cn(isMobile ? 'min-h-0' : 'flex-1')} disableHorizontal>
          {!projectDirectory ? (
            <div className="text-center text-muted-foreground py-8">{t('session.githubPrPicker.empty.noActiveProject')}</div>
          ) : null}

          {!github ? (
            <div className="text-center text-muted-foreground py-8">{t('session.githubPrPicker.empty.runtimeUnavailable')}</div>
          ) : null}

          {isLoading ? (
            <div className="text-center text-muted-foreground py-8 flex items-center justify-center gap-2">
              <Icon name="loader-4" className="h-4 w-4 animate-spin" />
              {t('session.githubPrPicker.loading.pullRequests')}
            </div>
          ) : null}

          {connected === false ? (
            <div className="text-center text-muted-foreground py-8 space-y-3">
              <div>{t('session.githubPrPicker.empty.notConnected')}</div>
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={openGitHubSettings}>
                  {t('session.githubPrPicker.actions.openSettings')}
                </Button>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="text-center text-muted-foreground py-8 break-words">{error}</div>
          ) : null}

          {prs.length === 0 && !isLoading && connected && github && projectDirectory ? (
            <div className="text-center text-muted-foreground py-8">{debouncedQuery.trim() ? t('session.githubPrPicker.empty.noPullRequestsFound') : t('session.githubPrPicker.empty.noOpenPullRequestsFound')}</div>
          ) : null}

          {prs.map((pr) => (
            <div
              key={`${pr.sourceRepo?.owner ?? ''}-${pr.sourceRepo?.repo ?? ''}-${pr.number}`}
              className={cn(
                'group flex items-center gap-2 py-1.5 hover:bg-interactive-hover/30 rounded transition-colors cursor-pointer',
                loadingPrNumber === pr.number && 'bg-interactive-selection/30'
              )}
              onClick={() => void attachPr(pr.number, pr.sourceRepo)}
            >
              <div className="flex-1 min-w-0 ml-0.5">
                <p className="typography-small text-foreground truncate">
                  <span className="text-muted-foreground mr-1">#{pr.number}</span>
                  {pr.title}
                </p>
                {pr.sourceRepo?.source === 'upstream' ? (
                  <span className="typography-micro px-1 py-0.5 rounded bg-status-info/10 text-status-info">
                    {pr.sourceRepo.owner}/{pr.sourceRepo.repo}
                  </span>
                ) : null}
                <p className="typography-meta text-muted-foreground truncate">{pr.head} → {pr.base}</p>
              </div>

              <div className="flex-shrink-0 h-5 flex items-center mr-2">
                {loadingPrNumber === pr.number ? (
                  <Icon name="loader-4" className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground transition-colors",
                      alwaysShowActions ? "flex" : "hidden group-hover:flex"
                    )}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={t('session.githubPrPicker.actions.openInGitHubAria')}
                  >
                    <Icon name="external-link" className="h-4 w-4" />
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
                    <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                    {t('session.githubPrPicker.loading.more')}
                  </span>
                ) : (
                  t('session.githubPrPicker.actions.loadMore')
                )}
              </button>
            </div>
          ) : null}
      </ScrollableOverlay>
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
            <Icon name="github" className="h-5 w-5" />
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
