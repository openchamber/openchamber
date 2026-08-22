import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGiteaAuthStore } from '@/stores/useGiteaAuthStore';
import { validateWorktreeCreate } from '@/lib/worktrees/worktreeManager';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Icon } from "@/components/icon/Icon";
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type {
  GiteaIssueSummary,
  GiteaPullRequestSummary,
} from '@/lib/api/types';
import type { ProjectRef } from '@/lib/worktrees/worktreeManager';
import { useI18n } from '@/lib/i18n';

type GiteaTab = 'issues' | 'prs';

interface GiteaIntegrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (result: {
    type: 'issue';
    number: number;
    title: string;
    url: string;
  } | {
    type: 'pr';
    number: number;
    title: string;
    url: string;
    sourceBranch: string;
    includeDiff: boolean;
  } | null) => void;
}

interface ValidationResult {
  isValid: boolean;
  error: string | null;
}

export function GiteaIntegrationDialog({
  open,
  onOpenChange,
  onSelect,
}: GiteaIntegrationDialogProps) {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const gitea = getRegisteredRuntimeAPIs()?.gitea;
  const giteaAuthStatus = useGiteaAuthStore((state) => state.status);
  const giteaAuthChecked = useGiteaAuthStore((state) => state.hasChecked);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const activeProject = useProjectsStore((state) => state.getActiveProject());

  const projectDirectory = activeProject?.path ?? null;
  const projectRef: ProjectRef | null = React.useMemo(() => {
    if (projectDirectory && activeProject) {
      return { id: activeProject.id, path: projectDirectory };
    }
    return null;
  }, [activeProject, projectDirectory]);

  // State
  const [activeTab, setActiveTab] = React.useState<GiteaTab>('issues');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [issues, setIssues] = React.useState<GiteaIssueSummary[]>([]);
  const [prs, setPrs] = React.useState<GiteaPullRequestSummary[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = React.useState<GiteaIssueSummary | null>(null);
  const [selectedPr, setSelectedPr] = React.useState<GiteaPullRequestSummary | null>(null);
  const [includeDiff, setIncludeDiff] = React.useState(false);
  const [validations, setValidations] = React.useState<Map<string, ValidationResult>>(new Map());
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);

  const debouncedSearchQuery = useDebouncedValue(searchQuery, 350);

  const loadData = React.useCallback(async (query?: string) => {
    if (!projectDirectory || !gitea) return;
    if (giteaAuthChecked && giteaAuthStatus?.connected === false) return;

    setLoading(true);
    setError(null);
    setPage(1);
    setHasMore(false);

    try {
      if (activeTab === 'issues' && gitea.issuesList) {
        const result = await gitea.issuesList(projectDirectory, { page: 1, query });
        if (result.connected === false) {
          setError(t('session.giteaIntegration.error.notConnected'));
          setIssues([]);
        } else {
          setIssues(result.issues ?? []);
          setPage(result.page ?? 1);
          setHasMore(Boolean(result.hasMore));
        }
      } else if (activeTab === 'prs' && gitea.prsList) {
        const result = await gitea.prsList(projectDirectory, { page: 1, query });
        if (result.connected === false) {
          setError(t('session.giteaIntegration.error.notConnected'));
          setPrs([]);
        } else {
          setPrs(result.prs ?? []);
          setPage(result.page ?? 1);
          setHasMore(Boolean(result.hasMore));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('session.giteaIntegration.error.loadDataFailed'));
    } finally {
      setLoading(false);
    }
  }, [projectDirectory, gitea, giteaAuthChecked, giteaAuthStatus, activeTab, t]);

  React.useEffect(() => {
    if (!open || !projectDirectory) return;
    if (giteaAuthChecked && giteaAuthStatus?.connected === false) return;
    if (!gitea) return;
    if (!debouncedSearchQuery.trim()) {
      void loadData();
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPage(1);
    setHasMore(false);

    const apiCall = activeTab === 'issues' && gitea.issuesList
      ? gitea.issuesList(projectDirectory, { page: 1, query: debouncedSearchQuery.trim() })
      : activeTab === 'prs' && gitea.prsList
        ? gitea.prsList(projectDirectory, { page: 1, query: debouncedSearchQuery.trim() })
        : null;

    if (!apiCall) {
      setLoading(false);
      return;
    }

    apiCall
      .then((result) => {
        if (controller.signal.aborted) return;
        if ('issues' in result) {
          if (result.connected === false) {
            setError(t('session.giteaIntegration.error.notConnected'));
            setIssues([]);
          } else {
            setIssues(result.issues ?? []);
            setPage(result.page ?? 1);
            setHasMore(Boolean(result.hasMore));
          }
        } else if ('prs' in result) {
          if (result.connected === false) {
            setError(t('session.giteaIntegration.error.notConnected'));
            setPrs([]);
          } else {
            setPrs(result.prs ?? []);
            setPage(result.page ?? 1);
            setHasMore(Boolean(result.hasMore));
          }
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : t('session.giteaIntegration.error.loadDataFailed'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [open, projectDirectory, gitea, giteaAuthChecked, giteaAuthStatus, activeTab, debouncedSearchQuery, loadData, t]);

  const loadMore = React.useCallback(async () => {
    if (!projectDirectory || !gitea) return;
    if (loading || loadingMore) return;
    if (!hasMore) return;

    setLoadingMore(true);

    try {
      const nextPage = page + 1;

      if (activeTab === 'issues' && gitea.issuesList) {
        const result = debouncedSearchQuery.trim()
          ? await gitea.issuesList(projectDirectory, { page: nextPage, query: debouncedSearchQuery.trim() })
          : await gitea.issuesList(projectDirectory, { page: nextPage });
        if (result.connected !== false) {
          setIssues(prev => [...prev, ...(result.issues ?? [])]);
          setPage(result.page ?? nextPage);
          setHasMore(Boolean(result.hasMore));
        }
      } else if (activeTab === 'prs' && gitea.prsList) {
        const result = debouncedSearchQuery.trim()
          ? await gitea.prsList(projectDirectory, { page: nextPage, query: debouncedSearchQuery.trim() })
          : await gitea.prsList(projectDirectory, { page: nextPage });
        if (result.connected !== false) {
          setPrs(prev => [...prev, ...(result.prs ?? [])]);
          setPage(result.page ?? nextPage);
          setHasMore(Boolean(result.hasMore));
        }
      }
    } catch {
      // Silently fail on load more errors
    } finally {
      setLoadingMore(false);
    }
  }, [projectDirectory, gitea, activeTab, page, hasMore, loading, loadingMore, debouncedSearchQuery]);

  // Reset state when dialog opens/closes
  React.useEffect(() => {
    if (!open) {
      setActiveTab('issues');
      setSearchQuery('');
      setIssues([]);
      setPrs([]);
      setSelectedIssue(null);
      setSelectedPr(null);
      setIncludeDiff(false);
      setError(null);
      setValidations(new Map());
      setPage(1);
      setHasMore(false);
      return;
    }

    void loadData();
  }, [open, loadData]);

  // Validate branches for worktree creation
  const validateBranch = React.useCallback(async (branchName: string) => {
    if (!projectRef || !branchName) return;

    // Check cache first
    if (validations.has(branchName)) return;

    try {
      const result = await validateWorktreeCreate(projectRef, {
        mode: 'new',
        branchName,
        worktreeName: branchName,
      });

      const blockingError = result.errors.find((entry) => entry.code === 'branch_in_use');

      setValidations(prev => new Map(prev).set(branchName, {
        isValid: !blockingError,
        error: blockingError
          ? t(blockingError.code === 'branch_exists'
            ? 'session.giteaIntegration.validation.branchAlreadyExists'
            : 'session.giteaIntegration.validation.branchAlreadyCheckedOut')
          : null,
      }));
    } catch {
      setValidations(prev => new Map(prev).set(branchName, {
        isValid: false,
        error: t('session.giteaIntegration.validation.failed'),
      }));
    }
  }, [projectRef, validations, t]);

  // Validate PR branches when loaded
  React.useEffect(() => {
    if (!open || activeTab !== 'prs') return;

    prs.forEach(pr => {
      if (pr.sourceBranch) {
        void validateBranch(pr.sourceBranch);
      }
    });
  }, [open, activeTab, prs, validateBranch]);

  // Gitea connection check
  const isGiteaConnected = giteaAuthChecked && giteaAuthStatus?.connected === true;

  const openGiteaSettings = () => {
    setSettingsPage('git');
    setSettingsDialogOpen(true);
  };

  // Handle selection
  const handleSelectIssue = (issue: GiteaIssueSummary) => {
    setSelectedIssue(issue);
    setSelectedPr(null);
  };

  const handleSelectPr = (pr: GiteaPullRequestSummary) => {
    setSelectedPr(pr);
    setSelectedIssue(null);
  };

  const handleConfirm = () => {
    if (selectedIssue) {
      onSelect({
        type: 'issue',
        number: selectedIssue.number,
        title: selectedIssue.title,
        url: selectedIssue.url,
      });
    } else if (selectedPr) {
      onSelect({
        type: 'pr',
        number: selectedPr.number,
        title: selectedPr.title,
        url: selectedPr.url,
        sourceBranch: selectedPr.sourceBranch,
        includeDiff,
      });
    }
    onOpenChange(false);
  };

  const handleClear = () => {
    setSelectedIssue(null);
    setSelectedPr(null);
    setIncludeDiff(false);
  };

  // Check if selection is valid
  const canConfirm = selectedIssue || (selectedPr && validations.get(selectedPr.sourceBranch)?.isValid !== false);

  // Check if PR is blocked
  const isPrBlocked = (pr: GiteaPullRequestSummary): boolean => {
    if (!pr.sourceBranch) return true;
    const validation = validations.get(pr.sourceBranch);
    return validation?.isValid === false;
  };

  // Content for the dialog (shared between mobile and desktop)
  const dialogContent = (
    <>
      {!isGiteaConnected ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 gap-4">
          <Icon name="git-pull-request" className="h-12 w-12 text-muted-foreground" />
          <div className="text-center">
            <p className="typography-ui-label text-foreground">{t('session.giteaIntegration.connect.title')}</p>
            <p className="typography-small text-muted-foreground mt-1">
              {t('session.giteaIntegration.connect.description')}
            </p>
          </div>
          <Button onClick={openGiteaSettings} size="sm">{t('session.giteaIntegration.connect.action')}</Button>
        </div>
      ) : (
        <>
          {/* Search */}
          <div className="relative mt-2">
            <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={activeTab === 'issues'
                ? t('session.giteaIntegration.search.issuesPlaceholder')
                : t('session.giteaIntegration.search.prsPlaceholder')}
              className="h-8 pl-9"
            />
          </div>

          {/* List Content */}
          <div className="mt-2 h-[300px] overflow-hidden">
            <div className="h-full overflow-y-auto">
              {/* Loading */}
              {loading && (
                <div className="flex items-center justify-center h-full">
                  <Icon name="loader-4" className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="flex items-center justify-center h-full">
                  <div className="flex items-center gap-2 p-2 rounded-md bg-destructive/10 text-destructive">
                    <Icon name="error-warning" className="h-4 w-4" />
                    <span className="typography-small">{error}</span>
                  </div>
                </div>
              )}

              {/* Issues List */}
              {!loading && !error && activeTab === 'issues' && (
                <div className="space-y-0.5 min-h-full">
                  {issues.length > 0 ? (
                    issues.map(issue => (
                      <button
                        key={issue.number}
                        onClick={() => handleSelectIssue(issue)}
                        className={cn(
                          'w-full text-left px-2 py-1.5 rounded transition-colors',
                          selectedIssue?.number === issue.number
                            ? 'bg-interactive-selection text-interactive-selection-foreground'
                            : 'hover:bg-interactive-hover'
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <span className="text-muted-foreground shrink-0 typography-micro">#{issue.number}</span>
                          <div className="min-w-0 flex-1">
                            <span className="typography-small line-clamp-2">{issue.title}</span>
                          </div>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="flex items-center justify-center h-[300px] text-center typography-small text-muted-foreground">
                      {t('session.giteaIntegration.empty.noIssuesFound')}
                    </div>
                  )}

                  {hasMore && !loadingMore && (
                    <div className="flex justify-center pt-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void loadMore()}
                        className="h-7 text-xs"
                      >
                        {t('session.giteaIntegration.actions.loadMore')}
                      </Button>
                    </div>
                  )}
                  {loadingMore && (
                    <div className="flex items-center justify-center py-2">
                      <Icon name="loader-4" className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  )}
                </div>
              )}

              {/* PRs List */}
              {!loading && !error && activeTab === 'prs' && (
                <div className="space-y-0.5 min-h-full">
                  {prs.length > 0 ? (
                    prs.map(pr => {
                      const blocked = isPrBlocked(pr);
                      const validation = pr.sourceBranch ? validations.get(pr.sourceBranch) : undefined;

                      return (
                        <button
                          key={pr.number}
                          onClick={() => !blocked && handleSelectPr(pr)}
                          disabled={blocked}
                          className={cn(
                            'w-full text-left px-2 py-1.5 rounded transition-colors',
                            selectedPr?.number === pr.number
                              ? 'bg-interactive-selection text-interactive-selection-foreground'
                              : blocked
                                ? 'opacity-50 cursor-not-allowed'
                                : 'hover:bg-interactive-hover'
                          )}
                        >
                          <div className="flex items-start gap-2">
                            <span className="text-muted-foreground shrink-0 typography-micro">#{pr.number}</span>
                            <div className="min-w-0 flex-1">
                              <span className="typography-small line-clamp-1">{pr.title}</span>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="typography-micro text-muted-foreground">
                                  {pr.sourceBranch} → {pr.targetBranch}
                                </span>
                                {pr.draft && (
                                  <span className="typography-micro px-1 py-0.5 rounded bg-status-info/10 text-status-info">
                                    {t('session.giteaIntegration.draftBadge')}
                                  </span>
                                )}
                                {blocked && validation?.error && (
                                  <span className="typography-micro text-destructive">
                                    {validation.error}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })
                  ) : (
                    <div className="flex items-center justify-center h-[300px] text-center typography-small text-muted-foreground">
                      {t('session.giteaIntegration.empty.noPullRequestsFound')}
                    </div>
                  )}

                  {hasMore && !loadingMore && (
                    <div className="flex justify-center pt-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void loadMore()}
                        className="h-7 text-xs"
                      >
                        {t('session.giteaIntegration.actions.loadMore')}
                      </Button>
                    </div>
                  )}
                  {loadingMore && (
                    <div className="flex items-center justify-center py-2">
                      <Icon name="loader-4" className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );

  // Footer content
  const footerContent = (
    <div className={cn(
      'w-full',
      isMobile ? 'flex flex-col gap-2' : 'flex flex-row items-center'
    )}>
      {/* Left side: Selected Item / Checkbox */}
      <div className={cn(
        'flex items-center gap-4',
        isMobile ? 'w-full justify-center order-1' : 'flex-1'
      )}>
        {/* Selected Issue/PR display - hidden on mobile (shown in header instead) */}
        {!isMobile && (selectedIssue || selectedPr) && (
          <div className="flex items-center gap-2 px-2 h-8 rounded-md bg-muted/50 border border-border/50">
            <Icon name="check" className="h-3.5 w-3.5 text-status-success shrink-0" />
            <span className="typography-small truncate max-w-[150px]">
              {selectedIssue
                ? t('session.giteaIntegration.selected.issueNumber', { number: selectedIssue.number })
                : t('session.giteaIntegration.selected.prNumber', { number: selectedPr?.number ?? '' })}
            </span>
            <button
              onClick={handleClear}
              className="text-muted-foreground hover:text-foreground shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
            >
              <Icon name="close" className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Include Diff Checkbox - only show when PR tab is active and PR is selected */}
        {activeTab === 'prs' && selectedPr && (
          <label className="flex items-center gap-2 cursor-pointer h-8">
            <Checkbox
              checked={includeDiff}
              onChange={(checked) => setIncludeDiff(checked)}
              ariaLabel={t('session.giteaIntegration.includeDiffAria')}
            />
            <span className="typography-small text-foreground">
              {t('session.giteaIntegration.includeDiff')}
            </span>
          </label>
        )}
      </div>

      {/* Right side: Buttons */}
      <div className={cn(
        'flex gap-2',
        isMobile ? 'w-full order-2' : 'justify-end'
      )}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOpenChange(false)}
          className={cn(isMobile && 'flex-1')}
        >
          {t('session.giteaIntegration.actions.cancel')}
        </Button>
        <Button
          size="sm"
          onClick={handleConfirm}
          disabled={!canConfirm}
          className={cn(isMobile && 'flex-1')}
        >
          {t('session.giteaIntegration.actions.select')}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      {isMobile ? (
        <MobileOverlayPanel
          open={open}
          title={t('session.giteaIntegration.title')}
          onClose={() => onOpenChange(false)}
          footer={!isGiteaConnected ? undefined : footerContent}
          renderHeader={(closeButton) => (
            <div className="flex flex-col gap-2 px-3 py-2 border-b border-border/40">
              <div className="flex items-center justify-between">
                <h2 className="typography-ui-label font-semibold text-foreground">{t('session.giteaIntegration.title')}</h2>
                {closeButton}
              </div>
              {/* Tabs - using SortableTabsStrip */}
              <div className="w-full">
                <SortableTabsStrip
                  items={[
                    { id: 'issues', label: t('session.giteaIntegration.tabs.issues'), icon: <Icon name="git-branch" className="h-3.5 w-3.5" /> },
                    { id: 'prs', label: t('session.giteaIntegration.tabs.pullRequests'), icon: <Icon name="git-pull-request" className="h-3.5 w-3.5" /> },
                  ]}
                  activeId={activeTab}
                  onSelect={(id) => {
                    setActiveTab(id as GiteaTab);
                    setSearchQuery('');
                  }}
                  variant="active-pill"
                  layoutMode="fit"
                />
              </div>

              {/* Selected Item Inline Display */}
              {(selectedIssue || selectedPr) && (
                <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-muted/50 border border-border/50">
                  <Icon name="check" className="h-3.5 w-3.5 text-status-success shrink-0" />
                  <span className="typography-small truncate flex-1">
                    {selectedIssue
                      ? t('session.giteaIntegration.selected.issueNumber', { number: selectedIssue.number })
                      : t('session.giteaIntegration.selected.prNumber', { number: selectedPr?.number ?? '' })}
                  </span>
                  <button
                    onClick={handleClear}
                    className="text-muted-foreground hover:text-foreground shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
                  >
                    <Icon name="close" className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}
        >
          {dialogContent}
        </MobileOverlayPanel>
      ) : (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="max-w-2xl max-h-[70vh] flex flex-col">
            <DialogHeader className="flex flex-row items-center justify-between">
              <div className="flex items-center gap-3">
                <DialogTitle className="flex items-center gap-2 shrink-0">
                  <Icon name="git-pull-request" className="h-5 w-5" />
                  {t('session.giteaIntegration.title')}
                </DialogTitle>

                {/* Tabs - using SortableTabsStrip */}
                <div className="w-[220px]">
                  <SortableTabsStrip
                    items={[
                      { id: 'issues', label: t('session.giteaIntegration.tabs.issues'), icon: <Icon name="git-branch" className="h-3.5 w-3.5" /> },
                      { id: 'prs', label: t('session.giteaIntegration.tabs.pullRequests'), icon: <Icon name="git-pull-request" className="h-3.5 w-3.5" /> },
                    ]}
                    activeId={activeTab}
                    onSelect={(id) => {
                      setActiveTab(id as GiteaTab);
                      setSearchQuery('');
                    }}
                    variant="active-pill"
                    layoutMode="fit"
                  />
                </div>
              </div>
            </DialogHeader>

            {dialogContent}

            {/* Footer */}
            <DialogFooter className="mt-1">
              {footerContent}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
