import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { getSourceControlProviderLabel } from '@/lib/source-control/identity';
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
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUIStore } from '@/stores/useUIStore';
import { useOpenSourceControlSettings } from '@/hooks/useOpenSourceControlSettings';
import { getSourceControlAuthKey, getSourceControlReadContextAuthState, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { appendMissingSourceControlItems, mergeIncompleteSourceControlPage } from '@/lib/source-control/identity';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { useDeviceInfo } from '@/lib/device';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { Issue, IssueComment } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { parseIssueReference } from '@/lib/source-control/issueReference';

const buildIssueContextText = (issue: Issue, comments: IssueComment[]) => (
  `Source control issue context (JSON)\n${JSON.stringify({ project: issue.project, issue, comments }, null, 2)}`
);

type SelectedIssue = {
  number: number;
  title: string;
  url: string;
  contextText: string;
  author?: { login: string; avatarUrl?: string };
};

export function IssuePickerDialog({
  open,
  onOpenChange,
  directory,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  directory: string | null;
  onSelect?: (issue: SelectedIssue) => void;
}) {
  const { t } = useI18n();
  const { sourceControl } = useRuntimeAPIs();
  const binding = useRepositoryBinding(directory, sourceControl, open);
  const isBindingCurrent = binding.isCurrent;
  const target = binding.contexts[0] ?? null;
  const authEntry = useSourceControlAuthStore((state) => (
    target ? state.entries[getSourceControlAuthKey(target)] : undefined
  ));
  const isMobile = useUIStore((state) => state.isMobile);
  const openSourceControlSettings = useOpenSourceControlSettings();
  const { isTablet } = useDeviceInfo();
  const alwaysShowActions = isMobile || isTablet;
  const [query, setQuery] = React.useState('');
  const [issues, setIssues] = React.useState<Issue[]>([]);
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const [loadingIssueNumber, setLoadingIssueNumber] = React.useState<number | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const isResolvingTarget = binding.status === 'loading';
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [requestError, setError] = React.useState<string | null>(null);
  const error = binding.error ? t('settings.gitlab.status.operationFailed')
    : binding.status === 'ready' && !target ? t('session.changeRequestPicker.error.noProvider') : requestError;
  const operationGenerationRef = React.useRef(0);

  const parsedReference = React.useMemo(() => parseIssueReference(query), [query]);
  const directReference = React.useMemo(() => {
    if (!parsedReference) return null;
    if (!parsedReference.identity) return parsedReference;
    if (!target || parsedReference.identity.provider !== target.provider) return null;
    return parsedReference.identity.instance === target.instance ? parsedReference : null;
  }, [parsedReference, target]);
  const debouncedQuery = useDebouncedValue(query, 350);
  const isTextSearch = debouncedQuery.trim().length > 0 && !parsedReference;
  const providerName = getSourceControlProviderLabel(target?.provider ?? 'github');
  const authState = target
    ? getSourceControlReadContextAuthState(authEntry, target)
    : { authChecked: false, connected: false };

  React.useLayoutEffect(() => {
    operationGenerationRef.current += 1;
    setIsLoadingMore(false);
    setLoadingIssueNumber(null);
    return () => {
      operationGenerationRef.current += 1;
    };
  }, [directory, open, target, authState.connected]);

  React.useLayoutEffect(() => {
    setIssues([]);
    setPage(1);
    setHasMore(false);
    setIsLoading(false);
    setError(null);
  }, [target, open]);

  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setLoadingIssueNumber(null);
      setError(null);
      setIssues([]);
      setPage(1);
      setHasMore(false);
      setIsLoading(false);
      return;
    }
    if (!directory || !target || !isBindingCurrent() || !authState.authChecked) return;
    if (!authState.connected) {
      setIssues([]);
      setHasMore(false);
      setPage(1);
      setIsLoading(false);
      setError(null);
      return;
    }

    const operationGeneration = operationGenerationRef.current;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    const searchQuery = debouncedQuery.trim();
    const options = searchQuery && !parsedReference ? { page: 1, query: searchQuery } : { page: 1 };
    void sourceControl.issuesList(target, options)
      .then((next) => {
        if (cancelled || !isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;
        setIssues((previous) => mergeIncompleteSourceControlPage(previous, next));
        setPage(next.page);
        setHasMore(next.hasMore);
      })
      .catch((cause) => {
        if (cancelled || !isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled && isBindingCurrent() && operationGeneration === operationGenerationRef.current) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authState.authChecked, authState.connected, debouncedQuery, directory, isBindingCurrent, open, parsedReference, sourceControl, target]);

  const loadMore = React.useCallback(async () => {
    if (!directory || !target || !isBindingCurrent() || !authState.connected || isLoadingMore || isLoading || !hasMore) return;

    const operationGeneration = operationGenerationRef.current;
    setIsLoadingMore(true);
    try {
      const nextPage = page + 1;
      const next = isTextSearch
        ? await sourceControl.issuesList(target, { page: nextPage, query: debouncedQuery.trim() })
        : await sourceControl.issuesList(target, { page: nextPage });
      if (!isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;
      setIssues((previous) => appendMissingSourceControlItems(previous, next.items));
      if (next.incompleteProjectIds?.length) {
        setHasMore(true);
        toast.error(t('session.githubIssuePicker.toast.loadMoreFailed'));
      } else {
        setPage(next.page);
        setHasMore(next.hasMore);
      }
    } catch (cause) {
      if (!isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      toast.error(t('session.githubIssuePicker.toast.loadMoreFailed'), { description: message });
    } finally {
      if (isBindingCurrent() && operationGeneration === operationGenerationRef.current) setIsLoadingMore(false);
    }
  }, [authState.connected, debouncedQuery, directory, hasMore, isBindingCurrent, isLoading, isLoadingMore, isTextSearch, page, sourceControl, t, target]);

  const attachIssue = React.useCallback(async (
    issueNumber: number,
    project?: { owner: string; name: string },
  ) => {
    if (!directory) {
      toast.error(t('session.githubIssuePicker.error.noActiveProject'));
      return;
    }
    if (!target || !isBindingCurrent() || !authState.connected || loadingIssueNumber) return;

    const operationGeneration = operationGenerationRef.current;
    setLoadingIssueNumber(issueNumber);
    try {
      const issue = await sourceControl.issueGet(target, issueNumber, project);
      if (!isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;
      if (!issue) {
        toast.error(t('session.githubIssuePicker.error.issueNotFound'));
        return;
      }

      const comments = await sourceControl.issueComments(target, issueNumber, {
        owner: issue.project.owner,
        name: issue.project.name,
      });
      if (!isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;
      onSelect?.({
        number: issue.number,
        title: issue.title,
        url: issue.url,
        contextText: buildIssueContextText(issue, comments),
        author: issue.author
          ? { login: issue.author.username, avatarUrl: issue.author.avatarUrl }
          : undefined,
      });
      onOpenChange(false);
    } catch (cause) {
      if (!isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      toast.error(t('session.githubIssuePicker.toast.loadIssueDetailsFailed'), { description: message });
    } finally {
      if (isBindingCurrent() && operationGeneration === operationGenerationRef.current) setLoadingIssueNumber(null);
    }
  }, [authState.connected, directory, isBindingCurrent, loadingIssueNumber, onOpenChange, onSelect, sourceControl, t, target]);

  const title = t('session.issuePicker.title');
  const description = t('session.issuePicker.description');
  const waitingForAuth = Boolean(target && !authState.authChecked);
  const content = (
    <>
      <div className="relative mt-2">
        <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('session.issuePicker.searchPlaceholder')}
          aria-label={t('session.issuePicker.searchPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="pl-9 w-full"
        />
      </div>

      <ScrollableOverlay outerClassName={cn('min-h-0 mt-2', !isMobile && 'flex-1')} disableHorizontal>
        {!directory ? (
          <div className="text-center text-muted-foreground py-8">{t('session.githubIssuePicker.empty.noActiveProject')}</div>
        ) : null}

        {isResolvingTarget || waitingForAuth || isLoading ? (
          <div className="text-center text-muted-foreground py-8 flex items-center justify-center gap-2">
            <Icon name="loader-4" className="h-4 w-4 animate-spin" />
            {t('session.issuePicker.loading.issues')}
          </div>
        ) : null}

        {target && authState.authChecked && !authState.connected ? (
          <div className="text-center text-muted-foreground py-8 space-y-3">
            <div>{t('gitView.pr.providerNotConnected', { provider: providerName })}</div>
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={openSourceControlSettings}>
                {t('session.githubIssuePicker.actions.openSettings')}
              </Button>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="text-center text-muted-foreground py-8 space-y-3">
            <div className="break-words">{error}</div>
            {binding.error ? (
              <div className="flex justify-center">
                <Button size="sm" variant="outline" onClick={() => void binding.retry()} disabled={isResolvingTarget}>
                  {t('settings.sourceControl.transport.retry')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {directReference && directory && target && authState.connected ? (
          <button
            type="button"
            className={cn(
              'w-full flex items-center gap-2 py-1.5 hover:bg-interactive-hover/30 rounded transition-colors text-left',
              loadingIssueNumber === directReference.number && 'bg-interactive-selection/30',
            )}
            onClick={() => void attachIssue(directReference.number, directReference.project)}
          >
            <span className="typography-meta text-muted-foreground w-8 text-right flex-shrink-0">#</span>
            <span className="flex-1 min-w-0 typography-small text-foreground truncate ml-0.5">
              {t('session.issuePicker.actions.useIssue', { number: directReference.number })}
            </span>
            <span className="flex-shrink-0 h-5 flex items-center mr-2">
              {loadingIssueNumber === directReference.number ? (
                <Icon name="loader-4" className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : null}
            </span>
          </button>
        ) : null}

        {issues.length === 0 && !isResolvingTarget && !waitingForAuth && !isLoading && !error && authState.connected && target && directory ? (
          <div className="text-center text-muted-foreground py-8">
            {debouncedQuery.trim() ? t('session.issuePicker.empty.noneFound') : t('session.issuePicker.empty.noneOpen')}
          </div>
        ) : null}

        {(target && authState.connected ? issues : []).map((issue) => (
          <div
            key={issue.id}
            className={cn(
              'group flex items-center gap-2 rounded transition-colors hover:bg-interactive-hover/30',
              loadingIssueNumber === issue.number && 'bg-interactive-selection/30',
            )}
          >
            <button
              type="button"
              className="flex flex-1 min-w-0 items-center gap-2 py-1.5 text-left"
              onClick={() => void attachIssue(issue.number, { owner: issue.project.owner, name: issue.project.name })}
            >
              <span className="typography-meta text-muted-foreground w-12 text-right flex-shrink-0">#{issue.number}</span>
              <span className="flex-1 min-w-0 ml-0.5">
                <span className="block typography-small text-foreground truncate">{issue.title}</span>
                {issue.project.remoteName === 'upstream' ? (
                  <span className="typography-micro px-1 py-0.5 rounded bg-status-info/10 text-status-info">
                    {issue.project.owner}/{issue.project.name}
                  </span>
                ) : null}
              </span>
            </button>
            <span className="flex-shrink-0 h-5 flex items-center mr-2">
              {loadingIssueNumber === issue.number ? (
                <Icon name="loader-4" className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <a
                  href={issue.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    'h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground transition-colors',
                    alwaysShowActions ? 'flex' : 'hidden group-hover:flex',
                  )}
                  aria-label={t('gitView.pr.actions.openOnProviderAria', { provider: providerName })}
                >
                  <Icon name="external-link" className="h-4 w-4" />
                </a>
              )}
            </span>
          </div>
        ))}

        {hasMore && authState.connected && target && directory ? (
          <div className="py-2 flex justify-center">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={isLoadingMore || Boolean(loadingIssueNumber)}
              className={cn(
                'typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4',
                (isLoadingMore || Boolean(loadingIssueNumber)) && 'opacity-50 cursor-not-allowed hover:text-muted-foreground',
              )}
            >
              {isLoadingMore ? (
                <span className="inline-flex items-center gap-2">
                  <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                  {t('session.githubIssuePicker.loading.more')}
                </span>
              ) : (
                t('session.githubIssuePicker.actions.loadMore')
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
            <Icon name="git-repository" className="h-5 w-5" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}
