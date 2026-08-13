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
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGitLabAuthStore } from '@/stores/useGitLabAuthStore';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { useDeviceInfo } from '@/lib/device';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { GitLabMergeRequestContextResult, GitLabMergeRequestSummary, GitLabMergeRequestsListResult } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

const parsePrNumber = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/\/merge_requests\/(\d+)(?:\b|\/|$)/i);
  if (urlMatch) {
    const parsed = Number(urlMatch[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  const shortMatch = trimmed.match(/^!?(\d+)$/);
  if (shortMatch) {
    const parsed = Number(shortMatch[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
};

const buildMergeRequestContextText = (payload: GitLabMergeRequestContextResult) => {
  return `GitLab merge request context (JSON)\n${JSON.stringify(payload, null, 2)}`;
};

export function GitLabMrPickerDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect?: (mr: {
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
  const { gitlab } = useRuntimeAPIs();
  const gitlabAuthStatus = useGitLabAuthStore((state) => state.status);
  const gitlabAuthChecked = useGitLabAuthStore((state) => state.hasChecked);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const isMobile = useUIStore((state) => state.isMobile);
  const { isTablet } = useDeviceInfo();
  const alwaysShowActions = isMobile || isTablet;
  const activeProject = useProjectsStore((state) => state.getActiveProject());

  const projectDirectory = activeProject?.path ?? null;

  const [query, setQuery] = React.useState('');
  const [includeDiff, setIncludeDiff] = React.useState(false);
  const [result, setResult] = React.useState<GitLabMergeRequestsListResult | null>(null);
  const [mrs, setMrs] = React.useState<GitLabMergeRequestSummary[]>([]);
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const [loadingMrNumber, setLoadingMrNumber] = React.useState<number | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const directNumber = React.useMemo(() => parsePrNumber(query), [query]);
  const debouncedQuery = useDebouncedValue(query, 350);
  const isTextSearch = debouncedQuery.trim().length > 0 && !directNumber;

  const refresh = React.useCallback(async () => {
    if (!projectDirectory) {
      setResult(null);
      setError(t('session.gitlabMrPicker.error.noActiveProject'));
      return;
    }
    if (gitlabAuthChecked && gitlabAuthStatus?.connected === false) {
      setResult({ connected: false, mrs: [], page: 1, hasMore: false });
      setMrs([]);
      setHasMore(false);
      setPage(1);
      setError(null);
      return;
    }
    if (!gitlab?.mrsList) {
      setResult(null);
      setError(t('session.gitlabMrPicker.error.runtimeUnavailable'));
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const next = await gitlab.mrsList(projectDirectory, { page: 1 });
      setResult(next);
      setMrs(next.mrs ?? []);
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
  }, [gitlab, gitlabAuthChecked, gitlabAuthStatus, projectDirectory, t]);

  React.useEffect(() => {
    if (!open || !projectDirectory) return;
    if (gitlabAuthChecked && gitlabAuthStatus?.connected === false) return;
    if (!gitlab?.mrsList) return;
    if (!debouncedQuery.trim() || directNumber) {
      void refresh();
      return;
    }

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    gitlab.mrsList(projectDirectory, { page: 1, query: debouncedQuery.trim() })
      .then((next) => {
        if (controller.signal.aborted) return;
        setResult(next);
        setMrs(next.mrs ?? []);
        setPage(next.page ?? 1);
        setHasMore(Boolean(next.hasMore));
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [open, projectDirectory, gitlab, gitlabAuthChecked, gitlabAuthStatus, debouncedQuery, directNumber, refresh, t]);

  const loadMore = React.useCallback(async () => {
    if (!projectDirectory) return;
    if (!gitlab?.mrsList) return;
    if (isLoadingMore || isLoading) return;
    if (!hasMore) return;

    setIsLoadingMore(true);
    try {
      const nextPage = page + 1;
      const next = isTextSearch
        ? await gitlab.mrsList(projectDirectory, { page: nextPage, query: debouncedQuery.trim() })
        : await gitlab.mrsList(projectDirectory, { page: nextPage });
      setResult(next);
      setMrs((prev) => [...prev, ...(next.mrs ?? [])]);
      setPage(next.page ?? nextPage);
      setHasMore(Boolean(next.hasMore));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('session.gitlabMrPicker.toast.loadMoreFailed'), { description: message });
    } finally {
      setIsLoadingMore(false);
    }
  }, [gitlab, hasMore, isLoading, isLoadingMore, isTextSearch, debouncedQuery, page, projectDirectory, t]);

  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setIncludeDiff(false);
      setLoadingMrNumber(null);
      setError(null);
      setResult(null);
      setMrs([]);
      setPage(1);
      setHasMore(false);
      setIsLoading(false);
      return;
    }
    void refresh();
  }, [open, refresh]);

  React.useEffect(() => {
    if (!open) return;
    if (gitlabAuthChecked && gitlabAuthStatus?.connected === false) {
      setResult({ connected: false, mrs: [], page: 1, hasMore: false });
      setMrs([]);
      setHasMore(false);
      setPage(1);
      setError(null);
    }
  }, [gitlabAuthChecked, gitlabAuthStatus, open]);

  const connected = gitlabAuthChecked ? result?.connected !== false : true;

  const openGitLabSettings = React.useCallback(() => {
    setSettingsPage('git');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage]);

  const attachMr = React.useCallback(async (mrNumber: number) => {
    if (!projectDirectory) {
      toast.error(t('session.gitlabMrPicker.error.noActiveProject'));
      return;
    }
    if (!gitlab?.mrContext) {
      toast.error(t('session.gitlabMrPicker.error.runtimeUnavailable'));
      return;
    }
    if (loadingMrNumber) return;

    setLoadingMrNumber(mrNumber);
    try {
      const context = await gitlab.mrContext(projectDirectory, mrNumber, {
        includeDiff,
      });

      if (context.connected === false) {
        toast.error(t('session.gitlabMrPicker.error.notConnected'));
        return;
      }

      if (!context.mr) {
        toast.error(t('session.gitlabMrPicker.error.mrNotFound'));
        return;
      }

      if (!context.repo) {
        toast.error(t('session.gitlabMrPicker.error.repoNotResolvable'), {
          description: t('session.gitlabMrPicker.error.repoMustBeGitlab'),
        });
        return;
      }

      if (onSelect) {
        const instructionsText = await renderMagicPrompt('gitlab.pr.review.instructions');
        onSelect({
          number: context.mr.number,
          title: context.mr.title,
          url: context.mr.url,
          head: context.mr.sourceBranch,
          base: context.mr.targetBranch,
          includeDiff,
          instructionsText,
          contextText: buildMergeRequestContextText(context),
          author: context.mr.author
            ? {
              login: context.mr.author.username,
              avatarUrl: context.mr.author.avatarUrl,
            }
            : undefined,
        });
      }
      onOpenChange(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('session.gitlabMrPicker.toast.loadDetailsFailed'), { description: message });
    } finally {
      setLoadingMrNumber(null);
    }
  }, [gitlab, includeDiff, loadingMrNumber, onOpenChange, onSelect, projectDirectory, t]);

  const title = t('session.gitlabMrPicker.title');
  const description = t('session.gitlabMrPicker.description');

  const content = (
    <>
      <div className="mt-2 flex items-center gap-3">
        <div className="relative flex-1 min-w-0">
          <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('session.gitlabMrPicker.searchPlaceholder')}
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
          aria-label={t('session.gitlabMrPicker.includeDiffAria')}
        >
          <span onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={includeDiff}
              onChange={(checked) => setIncludeDiff(checked)}
              ariaLabel={t('session.gitlabMrPicker.includeDiffAria')}
            />
          </span>
          <span className="typography-small text-muted-foreground whitespace-nowrap">{t('session.gitlabMrPicker.includeDiff')}</span>
        </button>
      </div>

      <div className={cn(isMobile ? 'min-h-0' : 'flex-1 overflow-y-auto')}>
          {!projectDirectory ? (
            <div className="text-center text-muted-foreground py-8">{t('session.gitlabMrPicker.empty.noActiveProject')}</div>
          ) : null}

          {!gitlab ? (
            <div className="text-center text-muted-foreground py-8">{t('session.gitlabMrPicker.empty.runtimeUnavailable')}</div>
          ) : null}

          {isLoading ? (
            <div className="text-center text-muted-foreground py-8 flex items-center justify-center gap-2">
              <Icon name="loader-4" className="h-4 w-4 animate-spin" />
              {t('session.gitlabMrPicker.loading.mergeRequests')}
            </div>
          ) : null}

          {connected === false ? (
            <div className="text-center text-muted-foreground py-8 space-y-3">
              <div>{t('session.gitlabMrPicker.empty.notConnected')}</div>
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={openGitLabSettings}>
                  {t('session.gitlabMrPicker.actions.openSettings')}
                </Button>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="text-center text-muted-foreground py-8 break-words">{error}</div>
          ) : null}

          {directNumber && projectDirectory && gitlab && connected ? (
            <div
              className={cn(
                'group flex items-center gap-2 py-1.5 hover:bg-interactive-hover/30 rounded transition-colors cursor-pointer',
                loadingMrNumber === directNumber && 'bg-interactive-selection/30'
              )}
              onClick={() => void attachMr(directNumber)}
            >
              <span className="typography-meta text-muted-foreground w-5 text-right flex-shrink-0">!</span>
              <p className="flex-1 min-w-0 typography-small text-foreground truncate ml-0.5">
                {t('session.gitlabMrPicker.actions.useMergeRequest', { number: directNumber })}
              </p>
              <div className="flex-shrink-0 h-5 flex items-center mr-2">
                {loadingMrNumber === directNumber ? (
                  <Icon name="loader-4" className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : null}
              </div>
            </div>
          ) : null}

          {mrs.length === 0 && !isLoading && connected && gitlab && projectDirectory ? (
            <div className="text-center text-muted-foreground py-8">{debouncedQuery.trim() ? t('session.gitlabMrPicker.empty.noMergeRequestsFound') : t('session.gitlabMrPicker.empty.noOpenMergeRequestsFound')}</div>
          ) : null}

          {mrs.map((mr) => (
            <div
              key={mr.number}
              className={cn(
                'group flex items-center gap-2 py-1.5 hover:bg-interactive-hover/30 rounded transition-colors cursor-pointer',
                loadingMrNumber === mr.number && 'bg-interactive-selection/30'
              )}
              onClick={() => void attachMr(mr.number)}
            >
              <div className="flex-1 min-w-0 ml-0.5">
                <p className="typography-small text-foreground truncate">
                  <span className="text-muted-foreground mr-1">!{mr.number}</span>
                  {mr.title}
                </p>
                <p className="typography-meta text-muted-foreground truncate">{mr.sourceBranch} → {mr.targetBranch}</p>
              </div>

              <div className="flex-shrink-0 h-5 flex items-center mr-2">
                {loadingMrNumber === mr.number ? (
                  <Icon name="loader-4" className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <a
                    href={mr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground transition-colors",
                      alwaysShowActions ? "flex" : "hidden group-hover:flex"
                    )}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={t('session.gitlabMrPicker.actions.openInGitLabAria')}
                  >
                    <Icon name="external-link" className="h-4 w-4" />
                  </a>
                )}
              </div>
            </div>
          ))}

          {hasMore && connected && projectDirectory && gitlab ? (
            <div className="py-2 flex justify-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={isLoadingMore || Boolean(loadingMrNumber)}
                className={cn(
                  'typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4',
                  (isLoadingMore || Boolean(loadingMrNumber)) && 'opacity-50 cursor-not-allowed hover:text-muted-foreground'
                )}
              >
                {isLoadingMore ? (
                  <span className="inline-flex items-center gap-2">
                    <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                    {t('session.gitlabMrPicker.loading.more')}
                  </span>
                ) : (
                  t('session.gitlabMrPicker.actions.loadMore')
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
            <Icon name="git-merge" className="h-5 w-5" />
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
