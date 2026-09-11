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
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUIStore } from '@/stores/useUIStore';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useDeviceInfo } from '@/lib/device';
import { buildIssueContextText, startLinearIssueSession } from '@/lib/linearStartSession';
import type { LinearIssueSummary, LinearMappingResult } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

const parseLinearIssueQuery = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/linear\.app\/(?:[^/]+\/)?issue\/([A-Za-z][A-Za-z0-9]*-\d+)/i);
  if (urlMatch) return urlMatch[1].toUpperCase();
  if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(trimmed)) return trimmed.toUpperCase();
  return null;
};

export function LinearIssuePickerDialog({
  open,
  onOpenChange,
  mode = 'select',
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode?: 'createSession' | 'select';
  onSelect?: (issue: {
    identifier: string;
    title: string;
    url: string;
    contextText: string;
    author?: { login: string; avatarUrl?: string };
  }) => void;
}) {
  const { t } = useI18n();
  const { linear } = useRuntimeAPIs();
  const linearAuthStatus = useLinearAuthStore((state) => state.status);
  const linearAuthChecked = useLinearAuthStore((state) => state.hasChecked);
  const refreshStatus = useLinearAuthStore((state) => state.refreshStatus);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const isMobile = useUIStore((state) => state.isMobile);
  const { isTablet } = useDeviceInfo();
  const alwaysShowActions = isMobile || isTablet;

  const [query, setQuery] = React.useState('');
  const [issues, setIssues] = React.useState<LinearIssueSummary[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [connected, setConnected] = React.useState(true);
  const [startingIssueKey, setStartingIssueKey] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [createInWorktree, setCreateInWorktree] = React.useState(false);
  const [mapping, setMapping] = React.useState<LinearMappingResult | null>(null);
  const [mappingError, setMappingError] = React.useState<string | null>(null);
  const listRequestId = React.useRef(0);

  const directIdentifier = React.useMemo(() => parseLinearIssueQuery(query), [query]);
  const debouncedQuery = useDebouncedValue(query, 350);

  const refresh = React.useCallback(async (search = '') => {
    if (linearAuthChecked && linearAuthStatus?.connected === false) {
      setConnected(false);
      setIssues([]);
      setHasMore(false);
      setCursor(null);
      setError(null);
      return;
    }
    if (!linear?.issuesList) {
      setConnected(true);
      setError(t('session.linearIssuePicker.error.runtimeUnavailable'));
      return;
    }

    const requestId = listRequestId.current + 1;
    listRequestId.current = requestId;
    setIsLoading(true);
    setError(null);
    try {
      const next = await linear.issuesList(search ? { query: search } : undefined);
      if (requestId !== listRequestId.current) return;
      setConnected(next.connected !== false);
      setIssues(next.issues ?? []);
      setCursor(next.cursor ?? null);
      setHasMore(Boolean(next.hasMore));
    } catch (e) {
      if (requestId !== listRequestId.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === listRequestId.current) {
        setIsLoading(false);
      }
    }
  }, [linear, linearAuthChecked, linearAuthStatus, t]);

  const refreshMapping = React.useCallback(async () => {
    if (mode !== 'createSession') {
      setMapping(null);
      setMappingError(null);
      return;
    }
    if (!linear?.mappingGet) {
      setMapping(null);
      setMappingError(t('session.linearIssuePicker.error.runtimeUnavailable'));
      return;
    }
    try {
      const next = await linear.mappingGet();
      setMapping(next);
      setMappingError(null);
    } catch (e) {
      setMapping(null);
      setMappingError(e instanceof Error ? e.message : String(e));
    }
  }, [linear, mode, t]);

  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setStartingIssueKey(null);
      setError(null);
      setIssues([]);
      setCursor(null);
      setHasMore(false);
      setIsLoading(false);
      setConnected(true);
      setCreateInWorktree(false);
      setMapping(null);
      setMappingError(null);
      return;
    }
    if (linear && !linearAuthChecked) {
      void refreshStatus(linear);
    }
  }, [open, linear, linearAuthChecked, refreshStatus]);

  React.useEffect(() => {
    if (!open) return;
    void refresh(debouncedQuery.trim());
  }, [open, debouncedQuery, refresh]);

  React.useEffect(() => {
    if (!open) return;
    void refreshMapping();
  }, [open, refreshMapping]);

  const loadMore = React.useCallback(async () => {
    if (!linear?.issuesList) return;
    if (isLoadingMore || isLoading) return;
    if (!hasMore || !cursor) return;

    const requestId = listRequestId.current + 1;
    listRequestId.current = requestId;
    setIsLoadingMore(true);
    try {
      const search = debouncedQuery.trim();
      const next = await linear.issuesList({
        query: search || undefined,
        cursor,
      });
      if (requestId !== listRequestId.current) return;
      setConnected(next.connected !== false);
      setIssues((prev) => [...prev, ...(next.issues ?? [])]);
      setCursor(next.cursor ?? null);
      setHasMore(Boolean(next.hasMore));
    } catch (e) {
      if (requestId !== listRequestId.current) return;
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('session.linearIssuePicker.toast.loadMoreFailed'), { description: message });
    } finally {
      if (requestId === listRequestId.current) {
        setIsLoadingMore(false);
      }
    }
  }, [cursor, debouncedQuery, hasMore, isLoading, isLoadingMore, linear, t]);

  const openLinearSettings = React.useCallback(() => {
    setSettingsPage('integrations');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage]);

  const selectIssue = React.useCallback(async (issueKey: string) => {
    if (!linear?.issueGet) {
      toast.error(t('session.linearIssuePicker.error.runtimeUnavailable'));
      return;
    }
    if (startingIssueKey) return;
    setStartingIssueKey(issueKey);
    try {
      const issueRes = await linear.issueGet(issueKey);
      if (issueRes.connected === false) {
        toast.error(t('session.linearIssuePicker.error.notConnected'));
        return;
      }
      const issue = issueRes.issue;
      if (!issue) {
        toast.error(t('session.linearIssuePicker.error.issueNotFound'));
        return;
      }
      const comments = issue.comments ?? [];
      const login = issue.assignee?.displayName || issue.assignee?.name;
      onSelect?.({
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        contextText: buildIssueContextText({ issue, comments }),
        author: login
          ? { login, avatarUrl: issue.assignee?.avatarUrl || undefined }
          : undefined,
      });
      onOpenChange(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('session.linearIssuePicker.toast.loadIssueDetailsFailed'), { description: message });
    } finally {
      setStartingIssueKey(null);
    }
  }, [linear, onOpenChange, onSelect, startingIssueKey, t]);

  const startSession = React.useCallback(async (issueKey: string) => {
    if (startingIssueKey) return;
    setStartingIssueKey(issueKey);
    try {
      await startLinearIssueSession({
        linear,
        issueKey,
        createInWorktree,
        mapping,
        onMappingLoaded: (next) => {
          setMapping(next);
          setMappingError(null);
        },
        onSessionCreated: () => onOpenChange(false),
        t,
      });
    } finally {
      setStartingIssueKey(null);
    }
  }, [createInWorktree, linear, mapping, onOpenChange, startingIssueKey, t]);

  const handleIssue = React.useCallback((issueKey: string) => {
    if (mode === 'select') {
      void selectIssue(issueKey);
      return;
    }
    void startSession(issueKey);
  }, [mode, selectIssue, startSession]);

  const title = mode === 'select'
    ? t('session.linearIssuePicker.title')
    : t('session.linearIssuePicker.title.createSession');
  const description = mode === 'select'
    ? t('session.linearIssuePicker.description')
    : t('session.linearIssuePicker.description.createSession');
  const showDisconnected = linearAuthChecked && connected === false;
  const runtimeMissing = !linear;

  const content = (
    <>
      <div className="relative mt-2">
        <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('session.linearIssuePicker.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9 w-full"
        />
      </div>

      <div className={cn(isMobile ? 'min-h-0 mt-2' : 'flex-1 overflow-y-auto mt-2')}>
        {runtimeMissing ? (
          <div className="text-center text-muted-foreground py-8">{t('session.linearIssuePicker.empty.runtimeUnavailable')}</div>
        ) : null}

        {mode === 'createSession' && mappingError ? (
          <div className="text-center text-muted-foreground py-8 break-words">{mappingError}</div>
        ) : null}

        {isLoading ? (
          <div className="text-center text-muted-foreground py-8 flex items-center justify-center gap-2">
            <Icon name="loader-4" className="h-4 w-4 animate-spin" />
            {t('session.linearIssuePicker.loading.issues')}
          </div>
        ) : null}

        {showDisconnected ? (
          <div className="text-center text-muted-foreground py-8 space-y-3">
            <div>{t('session.linearIssuePicker.empty.notConnected')}</div>
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={openLinearSettings}>
                {t('session.linearIssuePicker.actions.openSettings')}
              </Button>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="text-center text-muted-foreground py-8 break-words">{error}</div>
        ) : null}

        {directIdentifier && linear && connected ? (
          <div
            className={cn(
              'group flex items-center gap-2 py-1.5 hover:bg-interactive-hover/30 rounded transition-colors cursor-pointer',
              startingIssueKey === directIdentifier && 'bg-interactive-selection/30'
            )}
            onClick={() => handleIssue(directIdentifier)}
          >
            <span className="typography-meta text-muted-foreground w-16 text-right flex-shrink-0">
              {directIdentifier}
            </span>
            <p className="flex-1 min-w-0 typography-small text-foreground truncate ml-0.5">
              {t('session.linearIssuePicker.actions.useIssue', { identifier: directIdentifier })}
            </p>
            <div className="flex-shrink-0 h-5 flex items-center mr-2">
              {startingIssueKey === directIdentifier ? (
                <Icon name="loader-4" className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : null}
            </div>
          </div>
        ) : null}

        {issues.length === 0 && !isLoading && connected && linear ? (
          <div className="text-center text-muted-foreground py-8">
            {debouncedQuery.trim()
              ? t('session.linearIssuePicker.empty.noIssuesFound')
              : t('session.linearIssuePicker.empty.noOpenIssuesFound')}
          </div>
        ) : null}

        {issues.map((issue) => (
          <div
            key={issue.id}
            className={cn(
              'group flex items-center gap-2 py-1.5 hover:bg-interactive-hover/30 rounded transition-colors cursor-pointer',
              startingIssueKey === issue.id && 'bg-interactive-selection/30'
            )}
            onClick={() => handleIssue(issue.id)}
          >
            <span className="typography-meta text-muted-foreground w-16 text-right flex-shrink-0">
              {issue.identifier}
            </span>
            <p className="flex-1 min-w-0 typography-small text-foreground truncate ml-0.5">
              {issue.title}
            </p>
            <div className="flex-shrink-0 h-5 flex items-center mr-2">
              {startingIssueKey === issue.id ? (
                <Icon name="loader-4" className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <a
                  href={issue.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    'h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground transition-colors',
                    alwaysShowActions ? 'flex' : 'hidden group-hover:flex'
                  )}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={t('session.linearIssuePicker.actions.openInLinearAria')}
                >
                  <Icon name="external-link" className="h-4 w-4" />
                </a>
              )}
            </div>
          </div>
        ))}

        {hasMore && connected && linear ? (
          <div className="py-2 flex justify-center">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={isLoadingMore || Boolean(startingIssueKey)}
              className={cn(
                'typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4',
                (isLoadingMore || Boolean(startingIssueKey)) && 'opacity-50 cursor-not-allowed hover:text-muted-foreground'
              )}
            >
              {isLoadingMore ? (
                <span className="inline-flex items-center gap-2">
                  <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                  {t('session.linearIssuePicker.loading.more')}
                </span>
              ) : (
                t('session.linearIssuePicker.actions.loadMore')
              )}
            </button>
          </div>
        ) : null}
      </div>

      {mode !== 'select' ? (
        <div className="mt-4 p-3 bg-muted/30 rounded-lg">
          <p className="typography-meta text-muted-foreground font-medium mb-2">{t('session.linearIssuePicker.actions.sectionTitle')}</p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-2">
            <div
              className="flex items-center gap-2 cursor-pointer"
              role="button"
              tabIndex={0}
              aria-pressed={createInWorktree}
              onClick={() => setCreateInWorktree((value) => !value)}
              onKeyDown={(event) => {
                if (event.key === ' ' || event.key === 'Enter') {
                  event.preventDefault();
                  setCreateInWorktree((value) => !value);
                }
              }}
            >
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setCreateInWorktree((value) => !value);
                }}
                aria-label={t('session.linearIssuePicker.actions.toggleWorktreeAria')}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {createInWorktree ? (
                  <Icon name="checkbox" className="h-4 w-4 text-primary" />
                ) : (
                  <Icon name="checkbox-blank" className="h-4 w-4" />
                )}
              </button>
              <span className="typography-meta text-muted-foreground">{t('session.linearIssuePicker.actions.createInWorktree')}</span>
            </div>
            <div className="hidden sm:block sm:flex-1" />
            <Button variant="outline" size="sm" onClick={() => void refresh(debouncedQuery.trim())} disabled={isLoading || Boolean(startingIssueKey)}>
              {t('session.linearIssuePicker.actions.refresh')}
            </Button>
          </div>
        </div>
      ) : null}
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
            <Icon name="linear" className="h-5 w-5" />
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
