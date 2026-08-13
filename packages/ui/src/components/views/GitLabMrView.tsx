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
import { toast } from '@/components/ui';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

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

  // A different branch MR invalidates the update/merge transient state so the
  // previous MR's edit form, squash flag, and in-flight requests don't leak.
  React.useEffect(() => {
    setUpdateOpen(false);
    setEditTitle('');
    setEditDescription('');
    setEditDescriptionKnown(false);
    setEditDescriptionLoading(false);
    setUpdating(false);
    setMergeSquash(false);
    setMerging(false);
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

  // ---- Create / update / merge actions -----------------------------------

  const [createTitle, setCreateTitle] = React.useState('');
  const [createDescription, setCreateDescription] = React.useState('');
  const [createTargetBranch, setCreateTargetBranch] = React.useState('main');
  const [createRemoveSourceBranch, setCreateRemoveSourceBranch] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const createTargetTouchedRef = React.useRef(false);

  // The default target branch is the target of the repository's previously
  // listed open MRs when available; otherwise fall back to main.
  const defaultTargetBranch = React.useMemo(
    () => openMrs.find((mr) => mr.targetBranch)?.targetBranch ?? 'main',
    [openMrs],
  );

  // Adopt the repository's target branch default once the open-MR list
  // resolves, unless the user has already typed into the field.
  React.useEffect(() => {
    if (branchMrLoading || branchMr || createTargetTouchedRef.current) {
      return;
    }
    setCreateTargetBranch(defaultTargetBranch);
  }, [branchMr, branchMrLoading, defaultTargetBranch]);

  const [updateOpen, setUpdateOpen] = React.useState(false);
  const [editTitle, setEditTitle] = React.useState('');
  const [editDescription, setEditDescription] = React.useState('');
  const [editDescriptionKnown, setEditDescriptionKnown] = React.useState(false);
  const [editDescriptionLoading, setEditDescriptionLoading] = React.useState(false);
  const [updating, setUpdating] = React.useState(false);

  const [mergeSquash, setMergeSquash] = React.useState(false);
  const [merging, setMerging] = React.useState(false);

  const createMr = React.useCallback(async () => {
    if (!currentDirectory || !currentBranch || !gitlab?.mrCreate) {
      return;
    }
    const targetBranch = createTargetBranch.trim();
    if (!targetBranch) {
      return;
    }
    setCreating(true);
    try {
      const created = await gitlab.mrCreate({
        directory: currentDirectory,
        title: createTitle.trim() || currentBranch,
        sourceBranch: currentBranch,
        targetBranch,
        ...(createDescription.trim() ? { description: createDescription } : {}),
        ...(createRemoveSourceBranch ? { removeSourceBranch: true } : {}),
      });
      toast.success(t('contextPanel.gitlabMr.createMr.toast.created'));
      // Show the created MR immediately and refresh both the branch MR and
      // the open list so the card flips to the opened state.
      setBranchMr(created);
      setRetryToken((value) => value + 1);
      // Clear the form.
      setCreateTitle('');
      setCreateDescription('');
      setCreateRemoveSourceBranch(false);
      createTargetTouchedRef.current = false;
      setCreateTargetBranch(defaultTargetBranch);
    } catch (error) {
      toast.error(t('contextPanel.gitlabMr.createMr.toast.createFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCreating(false);
    }
  }, [createDescription, createRemoveSourceBranch, createTargetBranch, createTitle, currentBranch, currentDirectory, defaultTargetBranch, gitlab, t]);

  const toggleUpdate = React.useCallback(async () => {
    if (!branchMr) {
      return;
    }
    if (updateOpen) {
      setUpdateOpen(false);
      return;
    }
    setUpdateOpen(true);
    setEditTitle(branchMr.title);
    const knownBody = contextResult?.mr?.body;
    if (typeof knownBody === 'string') {
      setEditDescription(knownBody);
      setEditDescriptionKnown(true);
      return;
    }
    setEditDescription('');
    setEditDescriptionKnown(false);
    if (!currentDirectory || !gitlab?.mrContext) {
      return;
    }
    setEditDescriptionLoading(true);
    try {
      const result = await gitlab.mrContext(currentDirectory, branchMr.number, { includeDiff: false });
      if (result.connected === false) {
        setEditDescription('');
        return;
      }
      setEditDescription(result.mr?.body ?? '');
      setEditDescriptionKnown(true);
    } catch {
      // Leave the description empty; the title can still be edited.
    } finally {
      setEditDescriptionLoading(false);
    }
  }, [branchMr, contextResult?.mr?.body, currentDirectory, gitlab, updateOpen]);

  const saveMr = React.useCallback(async () => {
    if (!currentDirectory || !branchMr || !gitlab?.mrUpdate) {
      return;
    }
    const trimmedTitle = editTitle.trim();
    if (!trimmedTitle) {
      return;
    }
    setUpdating(true);
    try {
      await gitlab.mrUpdate({
        directory: currentDirectory,
        number: branchMr.number,
        title: trimmedTitle,
        // Only send the description when it was actually loaded so an
        // unresolved description can never be wiped out by a title-only save.
        ...(editDescriptionKnown ? { description: editDescription } : {}),
      });
      toast.success(t('contextPanel.gitlabMr.updateMr.toast.updated'));
      setUpdateOpen(false);
      setRetryToken((value) => value + 1);
    } catch (error) {
      toast.error(t('contextPanel.gitlabMr.updateMr.toast.updateFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setUpdating(false);
    }
  }, [branchMr, currentDirectory, editDescription, editDescriptionKnown, editTitle, gitlab, t]);

  const mergeMr = React.useCallback(async () => {
    if (!currentDirectory || !branchMr || !gitlab?.mrMerge) {
      return;
    }
    setMerging(true);
    try {
      const result = await gitlab.mrMerge({
        directory: currentDirectory,
        number: branchMr.number,
        ...(mergeSquash ? { squash: true } : {}),
      });
      if (result.merged) {
        toast.success(t('contextPanel.gitlabMr.mergeMr.toast.merged'));
      } else {
        toast.error(t('contextPanel.gitlabMr.mergeMr.toast.mergeFailed'), {
          ...(result.message ? { description: result.message } : {}),
        });
      }
      // Refresh the branch MR (flips to the merged state) and the open list.
      setRetryToken((value) => value + 1);
    } catch (error) {
      toast.error(t('contextPanel.gitlabMr.mergeMr.toast.mergeFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setMerging(false);
    }
  }, [branchMr, currentDirectory, gitlab, mergeSquash, t]);

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
                {branchMr.state === 'opened' ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 px-2"
                      onClick={() => void toggleUpdate()}
                      disabled={updating}
                    >
                      <Icon name="edit" className="size-4" />
                      {t('contextPanel.gitlabMr.updateMr.toggle')}
                    </Button>
                    <div
                      className="flex items-center gap-2 cursor-pointer"
                      role="button"
                      tabIndex={0}
                      aria-pressed={mergeSquash}
                      onClick={() => setMergeSquash((value) => !value)}
                      onKeyDown={(event) => {
                        if (event.key === ' ' || event.key === 'Enter') {
                          event.preventDefault();
                          setMergeSquash((value) => !value);
                        }
                      }}
                    >
                      <Checkbox
                        size="sm"
                        checked={mergeSquash}
                        onChange={(next) => setMergeSquash(next)}
                        ariaLabel={t('contextPanel.gitlabMr.mergeMr.squash')}
                      />
                      <span className="typography-ui-label text-foreground select-none">{t('contextPanel.gitlabMr.mergeMr.squash')}</span>
                    </div>
                    <Button
                      size="sm"
                      className="h-7 gap-1.5 px-2"
                      onClick={() => void mergeMr()}
                      disabled={merging || updating}
                    >
                      {merging ? <Icon name="loader-4" className="size-4 animate-spin" /> : <Icon name="git-merge" className="size-4" />}
                      {merging ? t('contextPanel.gitlabMr.mergeMr.merging') : t('contextPanel.gitlabMr.mergeMr.action')}
                    </Button>
                  </>
                ) : null}
              </div>

              {updateOpen && branchMr.state === 'opened' ? (
                <div className="flex min-w-0 flex-col gap-2 border-t border-border/40 pt-3">
                  <label className="space-y-1">
                    <div className="typography-micro text-muted-foreground">{t('contextPanel.gitlabMr.createMr.titleLabel')}</div>
                    <Input
                      value={editTitle}
                      onChange={(event) => setEditTitle(event.target.value)}
                      placeholder={t('contextPanel.gitlabMr.createMr.titlePlaceholder')}
                    />
                  </label>
                  <label className="space-y-1">
                    <div className="typography-micro text-muted-foreground">{t('contextPanel.gitlabMr.createMr.descriptionLabel')}</div>
                    {editDescriptionLoading ? (
                      <div className="flex items-center gap-2 typography-micro text-muted-foreground">
                        <Icon name="loader-4" className="size-4 animate-spin" />
                        {t('contextPanel.gitlabMr.loading')}
                      </div>
                    ) : (
                      <Textarea
                        value={editDescription}
                        onChange={(event) => setEditDescription(event.target.value)}
                        className="min-h-[80px]"
                        placeholder={t('gitView.pr.placeholder.whatChanged')}
                      />
                    )}
                  </label>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      className="h-7 gap-1.5 px-2"
                      onClick={() => void saveMr()}
                      disabled={updating || editDescriptionLoading || !editTitle.trim()}
                    >
                      {updating ? <Icon name="loader-4" className="size-4 animate-spin" /> : <Icon name="check" className="size-4" />}
                      {updating ? t('contextPanel.gitlabMr.updateMr.saving') : t('contextPanel.gitlabMr.updateMr.save')}
                    </Button>
                  </div>
                </div>
              ) : null}

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
          ) : currentBranch ? (
            <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border/40 p-3">
              <div className="typography-ui-label font-semibold text-foreground">{t('contextPanel.gitlabMr.createMr.title')}</div>

              <label className="space-y-1">
                <div className="typography-micro text-muted-foreground">{t('contextPanel.gitlabMr.createMr.sourceBranch')}</div>
                <Input value={currentBranch} readOnly />
              </label>

              <label className="space-y-1">
                <div className="typography-micro text-muted-foreground">{t('contextPanel.gitlabMr.createMr.targetBranch')}</div>
                <Input
                  value={createTargetBranch}
                  onChange={(event) => {
                    createTargetTouchedRef.current = true;
                    setCreateTargetBranch(event.target.value);
                  }}
                  placeholder="main"
                />
              </label>

              <label className="space-y-1">
                <div className="typography-micro text-muted-foreground">{t('contextPanel.gitlabMr.createMr.titleLabel')}</div>
                <Input
                  value={createTitle}
                  onChange={(event) => setCreateTitle(event.target.value)}
                  placeholder={currentBranch}
                />
              </label>

              <label className="space-y-1">
                <div className="typography-micro text-muted-foreground">{t('contextPanel.gitlabMr.createMr.descriptionLabel')}</div>
                <Textarea
                  value={createDescription}
                  onChange={(event) => setCreateDescription(event.target.value)}
                  className="min-h-[80px]"
                  placeholder={t('gitView.pr.placeholder.whatChanged')}
                />
              </label>

              <div
                className="flex items-center gap-2 cursor-pointer"
                role="button"
                tabIndex={0}
                aria-pressed={createRemoveSourceBranch}
                onClick={() => setCreateRemoveSourceBranch((value) => !value)}
                onKeyDown={(event) => {
                  if (event.key === ' ' || event.key === 'Enter') {
                    event.preventDefault();
                    setCreateRemoveSourceBranch((value) => !value);
                  }
                }}
              >
                <Checkbox
                  size="sm"
                  checked={createRemoveSourceBranch}
                  onChange={(next) => setCreateRemoveSourceBranch(next)}
                  ariaLabel={t('contextPanel.gitlabMr.createMr.removeSourceBranch')}
                />
                <span className="typography-ui-label text-foreground select-none">{t('contextPanel.gitlabMr.createMr.removeSourceBranch')}</span>
              </div>

              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="h-7 gap-1.5 px-2"
                  onClick={() => void createMr()}
                  disabled={creating || !createTargetBranch.trim()}
                >
                  {creating ? <Icon name="loader-4" className="size-4 animate-spin" /> : <Icon name="git-pull-request" className="size-4" />}
                  {creating ? t('contextPanel.gitlabMr.createMr.submitting') : t('contextPanel.gitlabMr.createMr.submit')}
                </Button>
              </div>
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
