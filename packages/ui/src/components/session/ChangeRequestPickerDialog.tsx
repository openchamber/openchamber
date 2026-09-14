import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { getChangeRequestReferencePrefix, getSourceControlProviderLabel } from '@/lib/source-control/identity';
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
import { useUIStore } from '@/stores/useUIStore';
import { useOpenSourceControlSettings } from '@/hooks/useOpenSourceControlSettings';
import { getSourceControlAuthKey, getSourceControlReadContextAuthState, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { appendMissingSourceControlItems, mergeIncompleteSourceControlPage } from '@/lib/source-control/identity';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { useDeviceInfo } from '@/lib/device';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { SourceControlProvider, ChangeRequest, ChangeRequestContext } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { parseChangeRequestReference } from '@/lib/source-control/changeRequestReference';

const buildChangeRequestContextText = (payload: ChangeRequestContext) => {
  return `Source control change request context (JSON)\n${JSON.stringify(payload, null, 2)}`;
};

export function ChangeRequestPickerDialog({
  open,
  onOpenChange,
  onSelect,
  directory,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  directory: string | null;
  onSelect?: (pr: {
    provider: SourceControlProvider;
    number: number;
    reference: string;
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
  const [includeDiff, setIncludeDiff] = React.useState(false);
  const [changeRequests, setChangeRequests] = React.useState<ChangeRequest[]>([]);
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const [loadingChangeRequestNumber, setLoadingChangeRequestNumber] = React.useState<number | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const isResolvingTarget = binding.status === 'loading';
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [requestError, setError] = React.useState<string | null>(null);
  const error = binding.error ? t('settings.gitlab.status.operationFailed')
    : binding.status === 'ready' && !target ? t('session.changeRequestPicker.error.noProvider') : requestError;
  const operationGenerationRef = React.useRef(0);

  const parsedReference = React.useMemo(() => parseChangeRequestReference(query), [query]);
  const directReference = React.useMemo(() => {
    if (!parsedReference) return null;
    if (!parsedReference.identity) return parsedReference;
    if (!target || parsedReference.identity.provider !== target.provider) return null;
    return parsedReference.identity.instance === target.instance ? parsedReference : null;
  }, [parsedReference, target]);
  const directNumber = directReference?.number ?? null;
  const debouncedQuery = useDebouncedValue(query, 350);
  const isTextSearch = debouncedQuery.trim().length > 0 && !parsedReference;
  const providerName = getSourceControlProviderLabel(target?.provider ?? 'github');
  const referencePrefix = getChangeRequestReferencePrefix(target?.provider ?? 'github');
  const authState = target
    ? getSourceControlReadContextAuthState(authEntry, target)
    : { authChecked: false, connected: false };

  React.useLayoutEffect(() => {
    operationGenerationRef.current += 1;
    setIsLoadingMore(false);
    setLoadingChangeRequestNumber(null);
    return () => {
      operationGenerationRef.current += 1;
    };
  }, [directory, open, target, authState.connected]);

  React.useLayoutEffect(() => {
    setChangeRequests([]);
    setPage(1);
    setHasMore(false);
    setIsLoading(false);
    setError(null);
  }, [target, open]);

  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setIncludeDiff(false);
      setLoadingChangeRequestNumber(null);
      setError(null);
      setChangeRequests([]);
      setPage(1);
      setHasMore(false);
      setIsLoading(false);
      return;
    }
    if (!directory || !target || !isBindingCurrent() || !authState.authChecked) return;
    if (!authState.connected) {
      setChangeRequests([]);
      setHasMore(false);
      setPage(1);
      setIsLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const operationGeneration = operationGenerationRef.current;
    setIsLoading(true);
    setError(null);

    const searchQuery = debouncedQuery.trim();
    const options = searchQuery && !parsedReference ? { page: 1, query: searchQuery } : { page: 1 };
    sourceControl.changeRequestsList(target, options)
      .then((next) => {
        if (controller.signal.aborted || !isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;
        setChangeRequests((previous) => mergeIncompleteSourceControlPage(previous, next));
        setPage(next.page);
        setHasMore(next.hasMore);
      })
      .catch((e) => {
        if (controller.signal.aborted || !isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted && isBindingCurrent() && operationGeneration === operationGenerationRef.current) setIsLoading(false);
      });

    return () => controller.abort();
  }, [authState.authChecked, authState.connected, debouncedQuery, directory, isBindingCurrent, open, parsedReference, sourceControl, target]);

  const loadMore = React.useCallback(async () => {
    if (!directory || !target || !isBindingCurrent() || !authState.connected) return;
    if (isLoadingMore || isLoading) return;
    if (!hasMore) return;

    const operationGeneration = operationGenerationRef.current;
    setIsLoadingMore(true);
    try {
      const nextPage = page + 1;
      const next = isTextSearch
        ? await sourceControl.changeRequestsList(target, { page: nextPage, query: debouncedQuery.trim() })
        : await sourceControl.changeRequestsList(target, { page: nextPage });
      if (!isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;
      setChangeRequests((previous) => appendMissingSourceControlItems(previous, next.items));
      if (next.incompleteProjectIds?.length) {
        setHasMore(true);
        toast.error(t('session.githubPrPicker.toast.loadMoreFailed'));
      } else {
        setPage(next.page);
        setHasMore(next.hasMore);
      }
    } catch (e) {
      if (!isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('session.githubPrPicker.toast.loadMoreFailed'), { description: message });
    } finally {
      if (isBindingCurrent() && operationGeneration === operationGenerationRef.current) setIsLoadingMore(false);
    }
  }, [authState.connected, debouncedQuery, directory, hasMore, isBindingCurrent, isLoading, isLoadingMore, isTextSearch, page, sourceControl, t, target]);

  const attachChangeRequest = React.useCallback(async (changeRequestNumber: number, changeRequest?: ChangeRequest) => {
    if (!directory) {
      toast.error(t('session.githubPrPicker.error.noActiveProject'));
      return;
    }
    if (!target || !isBindingCurrent() || !authState.connected || loadingChangeRequestNumber) return;

    const operationGeneration = operationGenerationRef.current;
    setLoadingChangeRequestNumber(changeRequestNumber);
    try {
      const context = await sourceControl.changeRequestContext(target, changeRequestNumber, {
        includeDiff,
        includeCIDetails: false,
        project: changeRequest
          ? { owner: changeRequest.project.owner, name: changeRequest.project.name }
          : directReference?.project,
      });
      if (!isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;

      if (!context.changeRequest) {
        toast.error(t('session.githubPrPicker.error.prNotFound'));
        return;
      }

      if (onSelect) {
        const instructionsText = await renderMagicPrompt('github.pr.review.instructions');
        if (!isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;
        onSelect({
          provider: context.changeRequest.provider,
          number: context.changeRequest.number,
          reference: `${referencePrefix}${context.changeRequest.number}`,
          title: context.changeRequest.title,
          url: context.changeRequest.url,
          head: context.changeRequest.head,
          base: context.changeRequest.base,
          includeDiff,
          instructionsText,
          contextText: buildChangeRequestContextText(context),
          author: context.changeRequest.author
            ? {
              login: context.changeRequest.author.username,
              avatarUrl: context.changeRequest.author.avatarUrl,
            }
            : undefined,
        });
      }
      onOpenChange(false);
    } catch (e) {
      if (!isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('session.githubPrPicker.toast.loadDetailsFailed'), { description: message });
    } finally {
      if (isBindingCurrent() && operationGeneration === operationGenerationRef.current) setLoadingChangeRequestNumber(null);
    }
  }, [authState.connected, directReference?.project, directory, includeDiff, isBindingCurrent, loadingChangeRequestNumber, onOpenChange, onSelect, referencePrefix, sourceControl, t, target]);

  const title = t('session.changeRequestPicker.title');
  const description = t('session.changeRequestPicker.description');
  const waitingForAuth = Boolean(target && !authState.authChecked);

  const content = (
    <>
      <div className="mt-2 flex items-center gap-3">
        <div className="relative flex-1 min-w-0">
          <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('session.changeRequestPicker.searchPlaceholder')}
            aria-label={t('session.changeRequestPicker.searchPlaceholder')}
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
          aria-label={t('session.changeRequestPicker.includeDiffAria')}
        >
          <span onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={includeDiff}
              onChange={(checked) => setIncludeDiff(checked)}
              ariaLabel={t('session.changeRequestPicker.includeDiffAria')}
            />
          </span>
          <span className="typography-small text-muted-foreground whitespace-nowrap">{t('session.changeRequestPicker.includeDiff')}</span>
        </button>
      </div>

      <ScrollableOverlay outerClassName={cn(isMobile ? 'min-h-0' : 'flex-1')} disableHorizontal>
          {!directory ? (
            <div className="text-center text-muted-foreground py-8">{t('session.githubPrPicker.empty.noActiveProject')}</div>
          ) : null}

          {isResolvingTarget || waitingForAuth || isLoading ? (
            <div className="text-center text-muted-foreground py-8 flex items-center justify-center gap-2">
              <Icon name="loader-4" className="h-4 w-4 animate-spin" />
              {t('session.changeRequestPicker.loading.changeRequests')}
            </div>
          ) : null}

          {target && authState.authChecked && !authState.connected ? (
            <div className="text-center text-muted-foreground py-8 space-y-3">
              <div>{t('gitView.pr.providerNotConnected', { provider: providerName })}</div>
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={openSourceControlSettings}>
                  {t('session.githubPrPicker.actions.openSettings')}
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

          {directNumber && directory && target && authState.connected ? (
            <button
              type="button"
              className={cn(
                'group flex w-full items-center gap-2 py-1.5 text-left hover:bg-interactive-hover/30 rounded transition-colors',
                loadingChangeRequestNumber === directNumber && 'bg-interactive-selection/30'
              )}
              onClick={() => void attachChangeRequest(directNumber)}
            >
              <span className="typography-meta text-muted-foreground w-5 text-right flex-shrink-0">{referencePrefix}</span>
              <p className="flex-1 min-w-0 typography-small text-foreground truncate ml-0.5">
                {t('session.changeRequestPicker.actions.useChangeRequest', { reference: `${referencePrefix}${directNumber}` })}
              </p>
              <div className="flex-shrink-0 h-5 flex items-center mr-2">
                {loadingChangeRequestNumber === directNumber ? (
                  <Icon name="loader-4" className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : null}
              </div>
            </button>
          ) : null}

          {changeRequests.length === 0 && !isResolvingTarget && !waitingForAuth && !isLoading && !error && authState.connected && target && directory ? (
            <div className="text-center text-muted-foreground py-8">{debouncedQuery.trim() ? t('session.changeRequestPicker.empty.noneFound') : t('session.changeRequestPicker.empty.noneOpen')}</div>
          ) : null}

          {(target && authState.connected ? changeRequests : []).map((changeRequest) => (
            <div
              key={`${changeRequest.project.id}-${changeRequest.number}`}
              className={cn(
                'group flex items-center gap-2 rounded transition-colors hover:bg-interactive-hover/30',
                loadingChangeRequestNumber === changeRequest.number && 'bg-interactive-selection/30'
              )}
            >
              <button
                type="button"
                className="min-w-0 flex-1 py-1.5 text-left"
                onClick={() => void attachChangeRequest(changeRequest.number, changeRequest)}
              >
                <div className="min-w-0 ml-0.5">
                  <p className="typography-small text-foreground truncate">
                    <span className="text-muted-foreground mr-1">{referencePrefix}{changeRequest.number}</span>
                    {changeRequest.title}
                  </p>
                  {changeRequest.project.remoteName === 'upstream' ? (
                    <span className="typography-micro px-1 py-0.5 rounded bg-status-info/10 text-status-info">
                      {changeRequest.project.owner}/{changeRequest.project.name}
                    </span>
                  ) : null}
                  <p className="typography-meta text-muted-foreground truncate">{changeRequest.head} → {changeRequest.base}</p>
                </div>
              </button>

              <div className="flex-shrink-0 h-5 flex items-center mr-2">
                {loadingChangeRequestNumber === changeRequest.number ? (
                  <Icon name="loader-4" className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <a
                    href={changeRequest.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground transition-colors",
                      alwaysShowActions ? "flex" : "hidden group-hover:flex"
                    )}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={t('gitView.pr.actions.openOnProviderAria', { provider: providerName })}
                  >
                    <Icon name="external-link" className="h-4 w-4" />
                  </a>
                )}
              </div>
            </div>
          ))}

          {hasMore && authState.connected && target && directory ? (
            <div className="py-2 flex justify-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={isLoadingMore || Boolean(loadingChangeRequestNumber)}
                className={cn(
                  'typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4',
                  (isLoadingMore || Boolean(loadingChangeRequestNumber)) && 'opacity-50 cursor-not-allowed hover:text-muted-foreground'
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
            <Icon name="git-pull-request" className="h-5 w-5" />
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
