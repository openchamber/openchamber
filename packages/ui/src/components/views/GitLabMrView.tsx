import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useGitStatus, useGitStore } from '@/stores/useGitStore';
import { useGitLabAuthStore } from '@/stores/useGitLabAuthStore';
import { useUIStore } from '@/stores/useUIStore';
import { openExternalUrl } from '@/lib/url';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import type { GitLabMergeRequestContextResult, GitLabMergeRequestSummary } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

const mrStateColor = (state: string): string => {
  switch (state) {
    case 'merged':
      return 'var(--pr-merged)';
    case 'closed':
      return 'var(--pr-closed)';
    default:
      return 'var(--pr-open)';
  }
};

const mrAuthorLabel = (mr: GitLabMergeRequestSummary): string =>
  mr.author?.name?.trim() || mr.author?.username || '';

const draftBadgeClass =
  'inline-flex items-center rounded border border-border/60 bg-surface-elevated px-1.5 py-px typography-micro text-foreground';

/**
 * Read-only GitLab merge request surface for the context panel. Resolves the
 * same repository context GitView uses (effective directory + current branch
 * from the shared git stores) and renders the branch's merge request plus the
 * repository's open merge requests. v1 is intentionally read-only: no create,
 * update, or merge actions.
 */
export const GitLabMrView: React.FC = () => {
  const { t } = useI18n();
  const { git, gitlab } = useRuntimeAPIs();
  const currentDirectory = useEffectiveDirectory();
  const status = useGitStatus(currentDirectory ?? null);
  const { ensureAll } = useGitStore(useShallow((state) => ({ ensureAll: state.ensureAll })));

  const gitlabAuthStatus = useGitLabAuthStore((state) => state.status);
  const gitlabAuthChecked = useGitLabAuthStore((state) => state.hasChecked);
  const refreshGitLabStatus = useGitLabAuthStore((state) => state.refreshStatus);

  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);

  React.useEffect(() => {
    if (!currentDirectory || !git) {
      return;
    }
    void ensureAll(currentDirectory, git);
  }, [currentDirectory, ensureAll, git]);

  // Settle the connection state exactly once; the store dedupes in-flight
  // refreshes so remounts never pile up status requests.
  React.useEffect(() => {
    if (gitlabAuthChecked) {
      return;
    }
    void refreshGitLabStatus(gitlab);
  }, [gitlab, gitlabAuthChecked, refreshGitLabStatus]);

  const currentBranch = status?.current ?? null;
  const connected = gitlabAuthChecked ? gitlabAuthStatus?.connected === true : null;

  const openGitLabSettings = React.useCallback(() => {
    setSettingsPage('git');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage]);

  // ---- Current-branch merge request --------------------------------------

  const [branchMr, setBranchMr] = React.useState<GitLabMergeRequestSummary | null>(null);
  const [branchMrLoading, setBranchMrLoading] = React.useState(false);
  const [branchMrError, setBranchMrError] = React.useState<string | null>(null);
  const [retryToken, setRetryToken] = React.useState(0);

  const retry = React.useCallback(() => setRetryToken((value) => value + 1), []);

  React.useEffect(() => {
    if (!currentDirectory || !currentBranch || !connected || !gitlab?.mrsList) {
      return;
    }
    let cancelled = false;
    setBranchMrLoading(true);
    setBranchMrError(null);
    void gitlab
      .mrsList(currentDirectory, { sourceBranch: currentBranch })
      .then((result) => {
        if (cancelled) {
          return;
        }
        const candidates = result.mrs ?? [];
        // Prefer the open MR for the branch; fall back to a merged one so a
        // just-merged branch still shows its request instead of nothing.
        const matching =
          candidates.find((mr) => mr.state === 'opened')
          ?? candidates.find((mr) => mr.state === 'merged')
          ?? null;
        setBranchMr(matching);
      })
      .catch((error) => {
        if (!cancelled) {
          setBranchMrError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBranchMrLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connected, currentBranch, currentDirectory, gitlab, retryToken]);

  // ---- Open merge requests in this repository ----------------------------

  const [openMrs, setOpenMrs] = React.useState<GitLabMergeRequestSummary[]>([]);
  const [listPage, setListPage] = React.useState(1);
  const [listHasMore, setListHasMore] = React.useState(false);
  const [listLoading, setListLoading] = React.useState(false);
  const [listLoadingMore, setListLoadingMore] = React.useState(false);
  const [listError, setListError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!currentDirectory || !connected || !gitlab?.mrsList) {
      return;
    }
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    void gitlab
      .mrsList(currentDirectory, { page: 1 })
      .then((result) => {
        if (cancelled) {
          return;
        }
        setOpenMrs(result.mrs ?? []);
        setListPage(result.page ?? 1);
        setListHasMore(Boolean(result.hasMore));
      })
      .catch((error) => {
        if (!cancelled) {
          setListError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setListLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connected, currentDirectory, gitlab, retryToken]);

  const loadMore = React.useCallback(async () => {
    if (!currentDirectory || !connected || !gitlab?.mrsList) {
      return;
    }
    if (listLoadingMore || listLoading || !listHasMore) {
      return;
    }
    setListLoadingMore(true);
    try {
      const next = await gitlab.mrsList(currentDirectory, { page: listPage + 1 });
      setOpenMrs((previous) => [...previous, ...(next.mrs ?? [])]);
      setListPage(next.page ?? listPage + 1);
      setListHasMore(Boolean(next.hasMore));
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setListLoadingMore(false);
    }
  }, [connected, currentDirectory, gitlab, listHasMore, listLoading, listLoadingMore, listPage]);

  // ---- Inline MR context (current-branch MR only) ------------------------

  const [contextOpen, setContextOpen] = React.useState(false);
  const [contextResult, setContextResult] = React.useState<GitLabMergeRequestContextResult | null>(null);
  const [contextLoading, setContextLoading] = React.useState(false);
  const [contextError, setContextError] = React.useState<string | null>(null);

  // A different branch MR invalidates any previously loaded context.
  React.useEffect(() => {
    setContextOpen(false);
    setContextResult(null);
    setContextError(null);
  }, [branchMr?.number]);

  const toggleContext = React.useCallback(async (mr: GitLabMergeRequestSummary) => {
    if (!currentDirectory || !gitlab?.mrContext) {
      return;
    }
    if (contextOpen) {
      setContextOpen(false);
      setContextResult(null);
      setContextError(null);
      return;
    }
    setContextOpen(true);
    setContextLoading(true);
    setContextError(null);
    try {
      const result = await gitlab.mrContext(currentDirectory, mr.number, { includeDiff: false });
      if (result.connected === false) {
        setContextError(t('contextPanel.gitlabMr.error.notConnected'));
      } else {
        setContextResult(result);
      }
    } catch (error) {
      setContextError(error instanceof Error ? error.message : String(error));
    } finally {
      setContextLoading(false);
    }
  }, [contextOpen, currentDirectory, gitlab, t]);

  const formatTimestamp = React.useCallback((value?: string) => {
    if (!value) {
      return '';
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
      return value;
    }
    return formatDateTimeForPreference(timestamp, timeFormatPreference, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }, [timeFormatPreference]);

  // ---- Render ------------------------------------------------------------

  if (!currentDirectory) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="git-merge" className="h-12 w-12 text-muted-foreground/50" />
        <div className="typography-ui-header text-foreground">{t('contextPanel.gitlabMr.title')}</div>
        <div className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.gitlabMr.empty.noActiveProject')}</div>
      </div>
    );
  }

  if (connected === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="loader-4" className="h-6 w-6 animate-spin text-muted-foreground" />
        <div className="typography-micro text-muted-foreground">{t('contextPanel.gitlabMr.loading')}</div>
      </div>
    );
  }

  if (connected === false) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="git-merge" className="h-12 w-12 text-muted-foreground/50" />
        <div className="typography-ui-header text-foreground">{t('contextPanel.gitlabMr.error.notConnected')}</div>
        <Button variant="outline" size="sm" onClick={openGitLabSettings} className="w-fit">
          {t('contextPanel.gitlabMr.actions.openSettings')}
        </Button>
      </div>
    );
  }

  const branchMrStateLabel = branchMr
    ? branchMr.state === 'merged'
      ? t('contextPanel.gitlabMr.state.merged')
      : branchMr.state === 'closed'
        ? t('contextPanel.gitlabMr.state.closed')
        : t('contextPanel.gitlabMr.state.opened')
    : '';
  const branchMrAuthor = branchMr ? mrAuthorLabel(branchMr) : '';
  const mrComments = contextResult?.comments ?? [];

  return (
    <ScrollableOverlay
      as={ScrollShadow}
      outerClassName="h-full min-h-0"
      className="px-4 py-3"
      disableHorizontal
      preventOverscroll
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <div className="typography-ui-header font-semibold text-foreground">{t('contextPanel.gitlabMr.title')}</div>
          <div className="typography-micro text-muted-foreground">{t('contextPanel.gitlabMr.listSectionTitle')}</div>
        </div>

        {/* Current-branch merge request */}
        <section className="flex min-w-0 flex-col gap-2">
          <h3 className="typography-ui-label font-semibold text-foreground">{t('contextPanel.gitlabMr.branchSectionTitle')}</h3>

          {branchMrLoading ? (
            <div className="flex items-center gap-2 typography-micro text-muted-foreground">
              <Icon name="loader-4" className="size-4 animate-spin" />
              {t('contextPanel.gitlabMr.loading')}
            </div>
          ) : branchMrError ? (
            <div className="flex flex-col gap-2">
              <div className="typography-ui-label text-foreground">{t('contextPanel.gitlabMr.error.loadFailed')}</div>
              <div className="typography-micro text-muted-foreground break-words">{branchMrError}</div>
              <Button variant="outline" size="sm" onClick={retry} className="w-fit">
                {t('contextPanel.preview.actions.retry')}
              </Button>
            </div>
          ) : branchMr ? (
            <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border/40 p-3">
              <div className="min-w-0">
                <div className="typography-ui-label text-foreground break-words leading-snug">
                  <span className="text-muted-foreground">!{branchMr.number}</span> {branchMr.title}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 typography-micro text-muted-foreground">
                  {branchMr.draft ? (
                    <span className={draftBadgeClass}>{t('contextPanel.gitlabMr.draft')}</span>
                  ) : null}
                  <span className="inline-flex items-center gap-1" style={{ color: mrStateColor(branchMr.state) }}>
                    <span className="size-1.5 rounded-full" style={{ backgroundColor: mrStateColor(branchMr.state) }} />
                    {branchMrStateLabel}
                  </span>
                  <span className="min-w-0 truncate">{branchMr.sourceBranch} → {branchMr.targetBranch}</span>
                </div>
                {branchMrAuthor ? (
                  <div className="mt-0.5 typography-micro text-muted-foreground">{branchMrAuthor}</div>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Button variant="outline" size="sm" asChild className="h-7 gap-1.5 px-2">
                  <a href={branchMr.url} target="_blank" rel="noopener noreferrer">
                    <Icon name="external-link" className="size-4" />
                    {t('contextPanel.gitlabMr.openInGitLab')}
                  </a>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 px-2"
                  onClick={() => void toggleContext(branchMr)}
                  disabled={contextLoading}
                >
                  {contextLoading ? (
                    <Icon name="loader-4" className="size-4 animate-spin" />
                  ) : contextOpen ? (
                    <Icon name="arrow-down-s" className="size-4 transition-transform rotate-180" />
                  ) : (
                    <Icon name="arrow-right-s" className="size-4" />
                  )}
                  {contextOpen ? t('contextPanel.gitlabMr.hideContext') : t('contextPanel.gitlabMr.loadContext')}
                </Button>
              </div>

              {contextOpen ? (
                <div className="flex min-w-0 flex-col gap-3 border-t border-border/40 pt-3">
                  {contextLoading ? (
                    <div className="flex items-center gap-2 typography-micro text-muted-foreground">
                      <Icon name="loader-4" className="size-4 animate-spin" />
                      {t('contextPanel.gitlabMr.loading')}
                    </div>
                  ) : contextError ? (
                    <div className="typography-micro text-muted-foreground break-words">{contextError}</div>
                  ) : (
                    <>
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="typography-micro font-semibold text-foreground">{t('gitView.pr.field.description')}</div>
                        {contextResult?.mr?.body?.trim() ? (
                          <SimpleMarkdownRenderer
                            content={contextResult.mr.body}
                            className="typography-markdown-body min-w-0 text-muted-foreground break-words"
                            enableFileReferences={false}
                          />
                        ) : (
                          <div className="typography-micro text-muted-foreground">{t('gitView.pr.noDescription')}</div>
                        )}
                      </div>
                      <div className="flex min-w-0 flex-col gap-2">
                        <div className="typography-micro font-semibold text-foreground">{t('gitView.pr.segment.comments')}</div>
                        {mrComments.length > 0 ? (
                          mrComments.map((comment) => (
                            <div key={comment.id} className="flex min-w-0 flex-col gap-1 rounded-lg bg-surface-elevated px-3 py-2">
                              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 typography-micro text-muted-foreground">
                                <span className="text-foreground whitespace-nowrap">
                                  {comment.author?.name?.trim() || comment.author?.username || ''}
                                </span>
                                {comment.createdAt ? (
                                  <span className="whitespace-nowrap">{formatTimestamp(comment.createdAt)}</span>
                                ) : null}
                              </div>
                              <SimpleMarkdownRenderer
                                content={comment.body || ''}
                                className="typography-markdown-body text-foreground break-words"
                                enableFileReferences={false}
                              />
                            </div>
                          ))
                        ) : (
                          <div className="typography-micro text-muted-foreground">{t('gitView.pr.comments.empty')}</div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="typography-micro text-muted-foreground">{t('contextPanel.gitlabMr.noMrForBranch')}</div>
          )}
        </section>

        {/* Open merge requests in this repository */}
        <section className="flex min-w-0 flex-col gap-2">
          <h3 className="typography-ui-label font-semibold text-foreground">{t('contextPanel.gitlabMr.openMrTitle')}</h3>

          {listLoading ? (
            <div className="flex items-center gap-2 typography-micro text-muted-foreground">
              <Icon name="loader-4" className="size-4 animate-spin" />
              {t('contextPanel.gitlabMr.loading')}
            </div>
          ) : listError ? (
            <div className="flex flex-col gap-2">
              <div className="typography-ui-label text-foreground">{t('contextPanel.gitlabMr.error.loadFailed')}</div>
              <div className="typography-micro text-muted-foreground break-words">{listError}</div>
              <Button variant="outline" size="sm" onClick={retry} className="w-fit">
                {t('contextPanel.preview.actions.retry')}
              </Button>
            </div>
          ) : openMrs.length === 0 ? (
            <div className="typography-micro text-muted-foreground">{t('contextPanel.gitlabMr.openMrEmpty')}</div>
          ) : (
            <div className="flex min-w-0 flex-col">
              {openMrs.map((mr) => (
                <div
                  key={mr.number}
                  className="group flex cursor-pointer items-center gap-2 rounded py-1.5 transition-colors hover:bg-interactive-hover/30"
                  onClick={() => void openExternalUrl(mr.url)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="typography-small truncate text-foreground">
                      <span className="mr-1 text-muted-foreground">!{mr.number}</span>
                      {mr.title}
                    </p>
                    <p className="typography-meta truncate text-muted-foreground">{mr.sourceBranch} → {mr.targetBranch}</p>
                  </div>
                  {mr.draft ? (
                    <span className={draftBadgeClass}>{t('contextPanel.gitlabMr.draft')}</span>
                  ) : null}
                  <a
                    href={mr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => event.stopPropagation()}
                    aria-label={t('contextPanel.gitlabMr.openInGitLab')}
                    className="hidden size-5 flex-shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground group-hover:flex"
                  >
                    <Icon name="external-link" className="size-4" />
                  </a>
                </div>
              ))}

              {listHasMore ? (
                <div className="flex justify-center py-2">
                  <Button variant="ghost" size="sm" onClick={() => void loadMore()} disabled={listLoadingMore}>
                    {listLoadingMore ? (
                      <Icon name="loader-4" className="size-4 animate-spin" />
                    ) : null}
                    {t('contextPanel.gitlabMr.loadMore')}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </ScrollableOverlay>
  );
};
