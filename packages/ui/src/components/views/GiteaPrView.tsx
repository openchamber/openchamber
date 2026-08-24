import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { GiteaIssuesSection } from '@/components/views/git/GiteaIssuesSection';
import { ForgeEntityDetailView } from '@/components/views/forge';
import { buildForgeProvider } from '@/lib/forge';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useGitStatus, useGitStore } from '@/stores/useGitStore';
import { useGiteaAuthStore } from '@/stores/useGiteaAuthStore';
import { useUIStore } from '@/stores/useUIStore';
import { openExternalUrl } from '@/lib/url';
import type { GiteaPullRequestContextResult, GiteaPullRequestSummary } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

const prStateColor = (state: string): string => {
  switch (state) {
    case 'merged':
      return 'var(--pr-merged)';
    case 'closed':
      return 'var(--pr-closed)';
    default:
      return 'var(--pr-open)';
  }
};

const prAuthorLabel = (pr: GiteaPullRequestSummary): string => pr.author?.username || '';

const draftBadgeClass =
  'inline-flex items-center rounded border border-border/60 bg-surface-elevated px-1.5 py-px typography-micro text-foreground';

/**
 * Read-only Gitea pull request surface for the context panel. Resolves the
 * same repository context GitView uses (effective directory + current branch
 * from the shared git stores) and renders the branch's pull request plus the
 * repository's open pull requests. Create, update, and merge actions are
 * offered for the current-branch PR.
 */
export const GiteaPrView: React.FC = () => {
  const { t } = useI18n();
  const { git, gitea } = useRuntimeAPIs();
  const currentDirectory = useEffectiveDirectory();
  const status = useGitStatus(currentDirectory ?? null);
  const { ensureAll } = useGitStore(useShallow((state) => ({ ensureAll: state.ensureAll })));

  const giteaAuthStatus = useGiteaAuthStore((state) => state.status);
  const giteaAuthChecked = useGiteaAuthStore((state) => state.hasChecked);
  const refreshGiteaStatus = useGiteaAuthStore((state) => state.refreshStatus);

  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);

  React.useEffect(() => {
    if (!currentDirectory || !git) {
      return;
    }
    void ensureAll(currentDirectory, git);
  }, [currentDirectory, ensureAll, git]);

  // Settle the connection state exactly once; the store dedupes in-flight
  // refreshes so remounts never pile up status requests.
  React.useEffect(() => {
    if (giteaAuthChecked) {
      return;
    }
    void refreshGiteaStatus(gitea);
  }, [gitea, giteaAuthChecked, refreshGiteaStatus]);

  const currentBranch = status?.current ?? null;
  const connected = giteaAuthChecked ? giteaAuthStatus?.connected === true : null;

  const openGiteaSettings = React.useCallback(() => {
    setSettingsPage('git');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage]);

  // Local tab selection between the pull-request and issues surfaces. Not
  // persisted: reopening the panel always lands on pull requests.
  const [activeTab, setActiveTab] = React.useState<'pr' | 'issues'>('pr');

  // ---- Current-branch pull request --------------------------------------

  const [branchPr, setBranchPr] = React.useState<GiteaPullRequestSummary | null>(null);
  const [branchPrLoading, setBranchPrLoading] = React.useState(false);
  const [branchPrError, setBranchPrError] = React.useState<string | null>(null);
  const [retryToken, setRetryToken] = React.useState(0);
  const [repoRef, setRepoRef] = React.useState<{ owner: string; repo: string; url?: string } | null>(null);

  const retry = React.useCallback(() => setRetryToken((value) => value + 1), []);

  React.useEffect(() => {
    if (!currentDirectory || !currentBranch || !connected || !gitea?.prsList) {
      return;
    }
    let cancelled = false;
    setBranchPrLoading(true);
    setBranchPrError(null);
    // Re-resolving the repo context invalidates the previously fetched branch
    // list so a stale repo's branches never leak into the create form.
    setRepoRef(null);
    setBranches([]);
    setDefaultBranch(null);
    void gitea
      .prsList(currentDirectory, { sourceBranch: currentBranch })
      .then((result) => {
        if (cancelled) {
          return;
        }
        const candidates = result.prs ?? [];
        // Prefer the open PR for the branch; fall back to a merged one so a
        // just-merged branch still shows its request instead of nothing.
        const matching =
          candidates.find((pr) => pr.state === 'open')
          ?? candidates.find((pr) => pr.state === 'merged')
          ?? null;
        setBranchPr(matching);
        setRepoRef(result.repo ?? null);
      })
      .catch((error) => {
        if (!cancelled) {
          setBranchPrError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBranchPrLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connected, currentBranch, currentDirectory, gitea, retryToken]);

  // ---- Open pull requests in this repository ----------------------------

  const [openPrs, setOpenPrs] = React.useState<GiteaPullRequestSummary[]>([]);
  const [listPage, setListPage] = React.useState(1);
  const [listHasMore, setListHasMore] = React.useState(false);
  const [listLoading, setListLoading] = React.useState(false);
  const [listLoadingMore, setListLoadingMore] = React.useState(false);
  const [listError, setListError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!currentDirectory || !connected || !gitea?.prsList) {
      return;
    }
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    void gitea
      .prsList(currentDirectory, { page: 1 })
      .then((result) => {
        if (cancelled) {
          return;
        }
        setOpenPrs(result.prs ?? []);
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
  }, [connected, currentDirectory, gitea, retryToken]);

  const loadMore = React.useCallback(async () => {
    if (!currentDirectory || !connected || !gitea?.prsList) {
      return;
    }
    if (listLoadingMore || listLoading || !listHasMore) {
      return;
    }
    setListLoadingMore(true);
    try {
      const next = await gitea.prsList(currentDirectory, { page: listPage + 1 });
      setOpenPrs((previous) => [...previous, ...(next.prs ?? [])]);
      setListPage(next.page ?? listPage + 1);
      setListHasMore(Boolean(next.hasMore));
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setListLoadingMore(false);
    }
  }, [connected, currentDirectory, gitea, listHasMore, listLoading, listLoadingMore, listPage]);

  // ---- Inline PR context (current-branch PR only) -----------------------

  const [contextOpen, setContextOpen] = React.useState(false);
  const [contextResult, setContextResult] = React.useState<GiteaPullRequestContextResult | null>(null);
  const [contextLoading, setContextLoading] = React.useState(false);

  // A different branch PR invalidates any previously loaded context.
  React.useEffect(() => {
    setContextOpen(false);
    setContextResult(null);
  }, [branchPr?.number]);

  // A different branch PR invalidates the update/merge transient state so the
  // previous PR's edit form and in-flight requests don't leak.
  React.useEffect(() => {
    setUpdateOpen(false);
    setEditTitle('');
    setEditDescription('');
    setEditDescriptionKnown(false);
    setEditDescriptionLoading(false);
    setUpdating(false);
    setMerging(false);
  }, [branchPr?.number]);

  const toggleContext = React.useCallback(async (pr: GiteaPullRequestSummary) => {
    if (!currentDirectory || !gitea?.prContext) {
      return;
    }
    if (contextOpen) {
      setContextOpen(false);
      setContextResult(null);
      return;
    }
    setContextOpen(true);
    setContextLoading(true);
    try {
      const result = await gitea.prContext(currentDirectory, pr.number, { includeDiff: false });
      setContextResult(result.connected === false ? null : result);
    } catch {
      setContextResult(null);
    } finally {
      setContextLoading(false);
    }
  }, [contextOpen, currentDirectory, gitea]);

  // Shared rich view for the branch PR's detail (title/body/chips/commits/
  // files/timeline/status strip). Owns its own fetching through the forge
  // facade; the commit-status capability renders the status strip in the
  // checks section automatically.
  const prProvider = React.useMemo(() => (gitea ? buildForgeProvider('gitea', { gitea }) : null), [gitea]);

  // ---- Create / update / merge actions -----------------------------------

  const [createTitle, setCreateTitle] = React.useState('');
  const [createDescription, setCreateDescription] = React.useState('');
  const [createSourceBranch, setCreateSourceBranch] = React.useState(currentBranch ?? '');
  const [createTargetBranch, setCreateTargetBranch] = React.useState('main');
  const [creating, setCreating] = React.useState(false);
  const createTargetTouchedRef = React.useRef(false);

  // Repository branches for the source/target dropdowns, fetched lazily once
  // the create form is visible.
  const [branches, setBranches] = React.useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = React.useState<string | null>(null);
  const [branchesLoading, setBranchesLoading] = React.useState(false);

  // The current branch is only known after git status resolves, so adopt it as
  // the default source branch when it arrives without clobbering a pick.
  React.useEffect(() => {
    if (currentBranch) {
      setCreateSourceBranch((previous) => previous || currentBranch);
    }
  }, [currentBranch]);

  // The default target branch is the target of the repository's previously
  // listed open PRs when available; otherwise fall back to main.
  const defaultTargetBranch = React.useMemo(
    () => openPrs.find((pr) => pr.targetBranch)?.targetBranch ?? 'main',
    [openPrs],
  );

  // Adopt the repository's target branch default once the open-PR list
  // resolves, unless the user has already typed into the field.
  React.useEffect(() => {
    if (branchPrLoading || branchPr || createTargetTouchedRef.current) {
      return;
    }
    setCreateTargetBranch(defaultBranch ?? defaultTargetBranch);
  }, [branchPr, branchPrLoading, defaultBranch, defaultTargetBranch]);

  // The source dropdown must always offer the picked/current branch, even
  // before the branch list resolves.
  const sourceBranchOptions = React.useMemo(() => {
    if (!createSourceBranch) {
      return branches;
    }
    return branches.includes(createSourceBranch) ? branches : [createSourceBranch, ...branches];
  }, [branches, createSourceBranch]);

  // A pull request cannot target its own source branch once there is more
  // than one branch to choose from.
  const targetBranchOptions = React.useMemo(
    () => (branches.length >= 2 ? branches.filter((branch) => branch !== createSourceBranch) : branches),
    [branches, createSourceBranch],
  );

  // Fetch the repository's branches lazily once the create form is visible so
  // the source/target dropdowns can offer real values. Gitea's branch API is
  // keyed by owner/repo, which the PR list result carries. Failure surfaces as
  // a toast and leaves the dropdowns on the current-branch fallback.
  React.useEffect(() => {
    if (!repoRef || branchPr || !connected || !gitea?.repoBranches) {
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    void gitea
      .repoBranches(repoRef.owner, repoRef.repo)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setBranches(result.branches ?? []);
        setDefaultBranch(result.defaultBranch ?? null);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setBranches([]);
        setDefaultBranch(null);
        toast.error(t('contextPanel.giteaPr.error.loadFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (!cancelled) {
          setBranchesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [branchPr, connected, gitea, repoRef, t]);

  const [updateOpen, setUpdateOpen] = React.useState(false);
  const [editTitle, setEditTitle] = React.useState('');
  const [editDescription, setEditDescription] = React.useState('');
  const [editDescriptionKnown, setEditDescriptionKnown] = React.useState(false);
  const [editDescriptionLoading, setEditDescriptionLoading] = React.useState(false);
  const [updating, setUpdating] = React.useState(false);

  const [merging, setMerging] = React.useState(false);

  const createPr = React.useCallback(async () => {
    if (!currentDirectory || !currentBranch || !gitea?.prCreate) {
      return;
    }
    const targetBranch = createTargetBranch.trim();
    if (!targetBranch) {
      return;
    }
    setCreating(true);
    try {
      const created = await gitea.prCreate({
        directory: currentDirectory,
        title: createTitle.trim() || currentBranch,
        sourceBranch: createSourceBranch,
        targetBranch,
        ...(createDescription.trim() ? { description: createDescription } : {}),
      });
      toast.success(t('contextPanel.giteaPr.createPr.toast.created'));
      // Show the created PR immediately and refresh both the branch PR and
      // the open list so the card flips to the opened state.
      setBranchPr(created);
      setRetryToken((value) => value + 1);
      // Clear the form.
      setCreateTitle('');
      setCreateDescription('');
      createTargetTouchedRef.current = false;
      setCreateTargetBranch(defaultBranch ?? defaultTargetBranch);
    } catch (error) {
      toast.error(t('contextPanel.giteaPr.createPr.toast.createFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCreating(false);
    }
  }, [createDescription, createSourceBranch, createTargetBranch, createTitle, currentBranch, currentDirectory, defaultBranch, defaultTargetBranch, gitea, t]);

  const toggleUpdate = React.useCallback(async () => {
    if (!branchPr) {
      return;
    }
    if (updateOpen) {
      setUpdateOpen(false);
      return;
    }
    setUpdateOpen(true);
    setEditTitle(branchPr.title);
    const knownBody = contextResult?.pr?.body;
    if (typeof knownBody === 'string') {
      setEditDescription(knownBody);
      setEditDescriptionKnown(true);
      return;
    }
    setEditDescription('');
    setEditDescriptionKnown(false);
    if (!currentDirectory || !gitea?.prContext) {
      return;
    }
    setEditDescriptionLoading(true);
    try {
      const result = await gitea.prContext(currentDirectory, branchPr.number, { includeDiff: false });
      if (result.connected === false) {
        setEditDescription('');
        return;
      }
      setEditDescription(result.pr?.body ?? '');
      setEditDescriptionKnown(true);
    } catch {
      // Leave the description empty; the title can still be edited.
    } finally {
      setEditDescriptionLoading(false);
    }
  }, [branchPr, contextResult?.pr?.body, currentDirectory, gitea, updateOpen]);

  const savePr = React.useCallback(async () => {
    if (!currentDirectory || !branchPr || !gitea?.prUpdate) {
      return;
    }
    const trimmedTitle = editTitle.trim();
    if (!trimmedTitle) {
      return;
    }
    setUpdating(true);
    try {
      await gitea.prUpdate({
        directory: currentDirectory,
        number: branchPr.number,
        title: trimmedTitle,
        // Only send the description when it was actually loaded so an
        // unresolved description can never be wiped out by a title-only save.
        ...(editDescriptionKnown ? { description: editDescription } : {}),
      });
      toast.success(t('contextPanel.giteaPr.updatePr.toast.updated'));
      setUpdateOpen(false);
      setRetryToken((value) => value + 1);
    } catch (error) {
      toast.error(t('contextPanel.giteaPr.updatePr.toast.updateFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setUpdating(false);
    }
  }, [branchPr, currentDirectory, editDescription, editDescriptionKnown, editTitle, gitea, t]);

  // Gitea merges with a method (merge/squash/rebase); there are no
  // method-selector labels in the gitea key set, so the default 'merge' method
  // is used without a selector.
  const mergePr = React.useCallback(async () => {
    if (!currentDirectory || !branchPr || !gitea?.prMerge) {
      return;
    }
    setMerging(true);
    try {
      const result = await gitea.prMerge({
        directory: currentDirectory,
        number: branchPr.number,
        method: 'merge',
      });
      if (result.merged) {
        toast.success(t('contextPanel.giteaPr.mergePr.toast.merged'));
      } else {
        toast.error(t('contextPanel.giteaPr.mergePr.toast.mergeFailed'), {
          ...(result.message ? { description: result.message } : {}),
        });
      }
      // Refresh the branch PR (flips to the merged state) and the open list.
      setRetryToken((value) => value + 1);
    } catch (error) {
      toast.error(t('contextPanel.giteaPr.mergePr.toast.mergeFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setMerging(false);
    }
  }, [branchPr, currentDirectory, gitea, t]);

  // ---- Render ------------------------------------------------------------

  if (!currentDirectory) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="git-pull-request" className="h-12 w-12 text-muted-foreground/50" />
        <div className="typography-ui-header text-foreground">{t('contextPanel.giteaPr.title')}</div>
        <div className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.giteaPr.empty.noActiveProject')}</div>
      </div>
    );
  }

  if (connected === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="loader-4" className="h-6 w-6 animate-spin text-muted-foreground" />
        <div className="typography-micro text-muted-foreground">{t('contextPanel.giteaPr.loading')}</div>
      </div>
    );
  }

  if (connected === false) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="git-pull-request" className="h-12 w-12 text-muted-foreground/50" />
        <div className="typography-ui-header text-foreground">{t('contextPanel.giteaPr.error.notConnected')}</div>
        <Button variant="outline" size="sm" onClick={openGiteaSettings} className="w-fit">
          {t('contextPanel.giteaPr.actions.openSettings')}
        </Button>
      </div>
    );
  }

  const branchPrStateLabel = branchPr
    ? branchPr.state === 'merged'
      ? t('contextPanel.giteaPr.state.merged')
      : branchPr.state === 'closed'
        ? t('contextPanel.giteaPr.state.closed')
        : t('contextPanel.giteaPr.state.opened')
    : '';
  const branchPrAuthor = branchPr ? prAuthorLabel(branchPr) : '';

  return (
    <ScrollableOverlay
      as={ScrollShadow}
      outerClassName="h-full min-h-0"
      className="px-4 py-3"
      disableHorizontal
      preventOverscroll
    >
      <div className="flex flex-col gap-4">
        <div className="flex h-8 min-w-0">
          <SortableTabsStrip
            className="h-full"
            items={[
              { id: 'pr', label: t('contextPanel.giteaPr.tabs.pullRequests') },
              { id: 'issues', label: t('contextPanel.giteaPr.tabs.issues') },
            ]}
            activeId={activeTab}
            onSelect={(tabId) => setActiveTab(tabId as 'pr' | 'issues')}
            layoutMode="fit"
            variant="active-pill"
            activePillButtonClassName="h-7"
          />
        </div>

        {activeTab === 'pr' ? (
          <>
        <div className="flex flex-col gap-0.5">
          <div className="typography-ui-header font-semibold text-foreground">{t('contextPanel.giteaPr.title')}</div>
          <div className="typography-micro text-muted-foreground">{t('contextPanel.giteaPr.listSectionTitle')}</div>
        </div>

        {/* Current-branch pull request */}
        <section className="flex min-w-0 flex-col gap-2">
          <h3 className="typography-ui-label font-semibold text-foreground">{t('contextPanel.giteaPr.branchSectionTitle')}</h3>

          {branchPrLoading ? (
            <div className="flex items-center gap-2 typography-micro text-muted-foreground">
              <Icon name="loader-4" className="size-4 animate-spin" />
              {t('contextPanel.giteaPr.loading')}
            </div>
          ) : branchPrError ? (
            <div className="flex flex-col gap-2">
              <div className="typography-ui-label text-foreground">{t('contextPanel.giteaPr.error.loadFailed')}</div>
              <div className="typography-micro text-muted-foreground break-words">{branchPrError}</div>
              <Button variant="outline" size="sm" onClick={retry} className="w-fit">
                {t('contextPanel.preview.actions.retry')}
              </Button>
            </div>
          ) : branchPr ? (
            <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border/40 p-3">
              <div className="min-w-0">
                <div className="typography-ui-label text-foreground break-words leading-snug">
                  <span className="text-muted-foreground">#{branchPr.number}</span> {branchPr.title}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 typography-micro text-muted-foreground">
                  {branchPr.draft ? (
                    <span className={draftBadgeClass}>{t('contextPanel.giteaPr.draft')}</span>
                  ) : null}
                  <span className="inline-flex items-center gap-1" style={{ color: prStateColor(branchPr.state) }}>
                    <span className="size-1.5 rounded-full" style={{ backgroundColor: prStateColor(branchPr.state) }} />
                    {branchPrStateLabel}
                  </span>
                  <span className="min-w-0 truncate">{branchPr.sourceBranch} → {branchPr.targetBranch}</span>
                </div>
                {branchPrAuthor ? (
                  <div className="mt-0.5 typography-micro text-muted-foreground">{branchPrAuthor}</div>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Button variant="outline" size="sm" asChild className="h-7 gap-1.5 px-2">
                  <a href={branchPr.url} target="_blank" rel="noopener noreferrer">
                    <Icon name="external-link" className="size-4" />
                    {t('contextPanel.giteaPr.openInGitea')}
                  </a>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 px-2"
                  onClick={() => void toggleContext(branchPr)}
                  disabled={contextLoading}
                >
                  {contextLoading ? (
                    <Icon name="loader-4" className="size-4 animate-spin" />
                  ) : contextOpen ? (
                    <Icon name="arrow-down-s" className="size-4 transition-transform rotate-180" />
                  ) : (
                    <Icon name="arrow-right-s" className="size-4" />
                  )}
                  {contextOpen ? t('contextPanel.giteaPr.hideContext') : t('contextPanel.giteaPr.loadContext')}
                </Button>
                {branchPr.state === 'open' ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 px-2"
                      onClick={() => void toggleUpdate()}
                      disabled={updating}
                    >
                      <Icon name="edit" className="size-4" />
                      {t('contextPanel.giteaPr.updatePr.toggle')}
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 gap-1.5 px-2"
                      onClick={() => void mergePr()}
                      disabled={merging || updating}
                    >
                      {merging ? <Icon name="loader-4" className="size-4 animate-spin" /> : <Icon name="git-merge" className="size-4" />}
                      {merging ? t('contextPanel.giteaPr.mergePr.merging') : t('contextPanel.giteaPr.mergePr.action')}
                    </Button>
                  </>
                ) : null}
              </div>

              {updateOpen && branchPr.state === 'open' ? (
                <div className="flex min-w-0 flex-col gap-2 border-t border-border/40 pt-3">
                  <label className="space-y-1">
                    <div className="typography-micro text-muted-foreground">{t('contextPanel.giteaPr.createPr.titleLabel')}</div>
                    <Input
                      value={editTitle}
                      onChange={(event) => setEditTitle(event.target.value)}
                      placeholder={t('contextPanel.giteaPr.createPr.titlePlaceholder')}
                    />
                  </label>
                  <label className="space-y-1">
                    <div className="typography-micro text-muted-foreground">{t('contextPanel.giteaPr.createPr.descriptionLabel')}</div>
                    {editDescriptionLoading ? (
                      <div className="flex items-center gap-2 typography-micro text-muted-foreground">
                        <Icon name="loader-4" className="size-4 animate-spin" />
                        {t('contextPanel.giteaPr.loading')}
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
                      onClick={() => void savePr()}
                      disabled={updating || editDescriptionLoading || !editTitle.trim()}
                    >
                      {updating ? <Icon name="loader-4" className="size-4 animate-spin" /> : <Icon name="check" className="size-4" />}
                      {updating ? t('contextPanel.giteaPr.updatePr.saving') : t('contextPanel.giteaPr.updatePr.save')}
                    </Button>
                  </div>
                </div>
              ) : null}

              {contextOpen && prProvider ? (
                <div className="flex min-w-0 flex-col gap-3 border-t border-border/40 pt-3">
                  <ForgeEntityDetailView
                    provider={prProvider}
                    directory={currentDirectory}
                    number={branchPr.number}
                    options={{ kind: 'pull' }}
                    onOpenSettings={openGiteaSettings}
                  />
                </div>
              ) : null}
            </div>
          ) : currentBranch ? (
            <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border/40 p-3">
              <div className="typography-ui-label font-semibold text-foreground">{t('contextPanel.giteaPr.createPr.title')}</div>

              <label className="space-y-1">
                <div className="typography-micro text-muted-foreground">{t('contextPanel.giteaPr.createPr.sourceBranch')}</div>
                <Select value={createSourceBranch} onValueChange={(value) => setCreateSourceBranch(value)}>
                  <SelectTrigger size="default" className="w-full">
                    <SelectValue>{branchesLoading ? t('contextPanel.giteaPr.createPr.branchesLoading') : createSourceBranch}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {sourceBranchOptions.map((branch) => (
                      <SelectItem key={branch} value={branch}>{branch}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>

              <label className="space-y-1">
                <div className="typography-micro text-muted-foreground">{t('contextPanel.giteaPr.createPr.targetBranch')}</div>
                <Select
                  value={createTargetBranch}
                  onValueChange={(value) => {
                    createTargetTouchedRef.current = true;
                    setCreateTargetBranch(value);
                  }}
                >
                  <SelectTrigger size="default" className="w-full">
                    <SelectValue>{branchesLoading ? t('contextPanel.giteaPr.createPr.branchesLoading') : createTargetBranch}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {targetBranchOptions.map((branch) => (
                      <SelectItem key={branch} value={branch}>{branch}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>

              <label className="space-y-1">
                <div className="typography-micro text-muted-foreground">{t('contextPanel.giteaPr.createPr.titleLabel')}</div>
                <Input
                  value={createTitle}
                  onChange={(event) => setCreateTitle(event.target.value)}
                  placeholder={currentBranch}
                />
              </label>

              <label className="space-y-1">
                <div className="typography-micro text-muted-foreground">{t('contextPanel.giteaPr.createPr.descriptionLabel')}</div>
                <Textarea
                  value={createDescription}
                  onChange={(event) => setCreateDescription(event.target.value)}
                  className="min-h-[80px]"
                  placeholder={t('gitView.pr.placeholder.whatChanged')}
                />
              </label>

              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="h-7 gap-1.5 px-2"
                  onClick={() => void createPr()}
                  disabled={creating || !createTargetBranch.trim()}
                >
                  {creating ? <Icon name="loader-4" className="size-4 animate-spin" /> : <Icon name="git-pull-request" className="size-4" />}
                  {creating ? t('contextPanel.giteaPr.createPr.submitting') : t('contextPanel.giteaPr.createPr.submit')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="typography-micro text-muted-foreground">{t('contextPanel.giteaPr.noPrForBranch')}</div>
          )}
        </section>

        {/* Open pull requests in this repository */}
        <section className="flex min-w-0 flex-col gap-2">
          <h3 className="typography-ui-label font-semibold text-foreground">{t('contextPanel.giteaPr.openPrTitle')}</h3>

          {listLoading ? (
            <div className="flex items-center gap-2 typography-micro text-muted-foreground">
              <Icon name="loader-4" className="size-4 animate-spin" />
              {t('contextPanel.giteaPr.loading')}
            </div>
          ) : listError ? (
            <div className="flex flex-col gap-2">
              <div className="typography-ui-label text-foreground">{t('contextPanel.giteaPr.error.loadFailed')}</div>
              <div className="typography-micro text-muted-foreground break-words">{listError}</div>
              <Button variant="outline" size="sm" onClick={retry} className="w-fit">
                {t('contextPanel.preview.actions.retry')}
              </Button>
            </div>
          ) : openPrs.length === 0 ? (
            <div className="typography-micro text-muted-foreground">{t('contextPanel.giteaPr.openPrEmpty')}</div>
          ) : (
            <div className="flex min-w-0 flex-col">
              {openPrs.map((pr) => (
                <div
                  key={pr.number}
                  className="group flex cursor-pointer items-center gap-2 rounded py-1.5 transition-colors hover:bg-interactive-hover/30"
                  onClick={() => void openExternalUrl(pr.url)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="typography-small truncate text-foreground">
                      <span className="mr-1 text-muted-foreground">#{pr.number}</span>
                      {pr.title}
                    </p>
                    <p className="typography-meta truncate text-muted-foreground">{pr.sourceBranch} → {pr.targetBranch}</p>
                  </div>
                  {pr.draft ? (
                    <span className={draftBadgeClass}>{t('contextPanel.giteaPr.draft')}</span>
                  ) : null}
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => event.stopPropagation()}
                    aria-label={t('contextPanel.giteaPr.openInGitea')}
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
                    {t('contextPanel.giteaPr.loadMore')}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </section>
          </>
        ) : (
          <GiteaIssuesSection directory={currentDirectory} />
        )}
      </div>
    </ScrollableOverlay>
  );
};
