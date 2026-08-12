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
import { useGitLabAuthStore } from '@/stores/useGitLabAuthStore';
import { validateWorktreeCreate } from '@/lib/worktrees/worktreeManager';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Icon } from "@/components/icon/Icon";
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type {
  GitLabIssueSummary,
  GitLabMergeRequestSummary,
} from '@/lib/api/types';
import type { ProjectRef } from '@/lib/worktrees/worktreeManager';
import { useI18n } from '@/lib/i18n';

type GitLabTab = 'issues' | 'mrs';

interface GitLabIntegrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (result: {
    type: 'issue';
    number: number;
    title: string;
    url: string;
  } | {
    type: 'mr';
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

export function GitLabIntegrationDialog({
  open,
  onOpenChange,
  onSelect,
}: GitLabIntegrationDialogProps) {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const gitlab = getRegisteredRuntimeAPIs()?.gitlab;
  const gitlabAuthStatus = useGitLabAuthStore((state) => state.status);
  const gitlabAuthChecked = useGitLabAuthStore((state) => state.hasChecked);
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
  const [activeTab, setActiveTab] = React.useState<GitLabTab>('issues');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [issues, setIssues] = React.useState<GitLabIssueSummary[]>([]);
  const [mrs, setMrs] = React.useState<GitLabMergeRequestSummary[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = React.useState<GitLabIssueSummary | null>(null);
  const [selectedMr, setSelectedMr] = React.useState<GitLabMergeRequestSummary | null>(null);
  const [includeDiff, setIncludeDiff] = React.useState(false);
  const [validations, setValidations] = React.useState<Map<string, ValidationResult>>(new Map());
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);

  const debouncedSearchQuery = useDebouncedValue(searchQuery, 350);

  const loadData = React.useCallback(async (query?: string) => {
    if (!projectDirectory || !gitlab) return;
    if (gitlabAuthChecked && gitlabAuthStatus?.connected === false) return;
    
    setLoading(true);
    setError(null);
    setPage(1);
    setHasMore(false);
    
    try {
      if (activeTab === 'issues' && gitlab.issuesList) {
        const result = await gitlab.issuesList(projectDirectory, { page: 1, query });
        if (result.connected === false) {
          setError(t('session.gitlabIntegration.error.notConnected'));
          setIssues([]);
        } else {
          setIssues(result.issues ?? []);
          setPage(result.page ?? 1);
          setHasMore(Boolean(result.hasMore));
        }
      } else if (activeTab === 'mrs' && gitlab.mrsList) {
        const result = await gitlab.mrsList(projectDirectory, { page: 1, query });
        if (result.connected === false) {
          setError(t('session.gitlabIntegration.error.notConnected'));
          setMrs([]);
        } else {
          setMrs(result.mrs ?? []);
          setPage(result.page ?? 1);
          setHasMore(Boolean(result.hasMore));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('session.gitlabIntegration.error.loadDataFailed'));
    } finally {
      setLoading(false);
    }
  }, [projectDirectory, gitlab, gitlabAuthChecked, gitlabAuthStatus, activeTab, t]);

  React.useEffect(() => {
    if (!open || !projectDirectory) return;
    if (gitlabAuthChecked && gitlabAuthStatus?.connected === false) return;
    if (!gitlab) return;
    if (!debouncedSearchQuery.trim()) {
      void loadData();
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPage(1);
    setHasMore(false);

    const apiCall = activeTab === 'issues' && gitlab.issuesList
      ? gitlab.issuesList(projectDirectory, { page: 1, query: debouncedSearchQuery.trim() })
      : activeTab === 'mrs' && gitlab.mrsList
        ? gitlab.mrsList(projectDirectory, { page: 1, query: debouncedSearchQuery.trim() })
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
            setError(t('session.gitlabIntegration.error.notConnected'));
            setIssues([]);
          } else {
            setIssues(result.issues ?? []);
            setPage(result.page ?? 1);
            setHasMore(Boolean(result.hasMore));
          }
        } else if ('mrs' in result) {
          if (result.connected === false) {
            setError(t('session.gitlabIntegration.error.notConnected'));
            setMrs([]);
          } else {
            setMrs(result.mrs ?? []);
            setPage(result.page ?? 1);
            setHasMore(Boolean(result.hasMore));
          }
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : t('session.gitlabIntegration.error.loadDataFailed'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [open, projectDirectory, gitlab, gitlabAuthChecked, gitlabAuthStatus, activeTab, debouncedSearchQuery, loadData, t]);

  const loadMore = React.useCallback(async () => {
    if (!projectDirectory || !gitlab) return;
    if (loading || loadingMore) return;
    if (!hasMore) return;
    
    setLoadingMore(true);
    
    try {
      const nextPage = page + 1;
      
      if (activeTab === 'issues' && gitlab.issuesList) {
        const result = debouncedSearchQuery.trim()
          ? await gitlab.issuesList(projectDirectory, { page: nextPage, query: debouncedSearchQuery.trim() })
          : await gitlab.issuesList(projectDirectory, { page: nextPage });
        if (result.connected !== false) {
          setIssues(prev => [...prev, ...(result.issues ?? [])]);
          setPage(result.page ?? nextPage);
          setHasMore(Boolean(result.hasMore));
        }
      } else if (activeTab === 'mrs' && gitlab.mrsList) {
        const result = debouncedSearchQuery.trim()
          ? await gitlab.mrsList(projectDirectory, { page: nextPage, query: debouncedSearchQuery.trim() })
          : await gitlab.mrsList(projectDirectory, { page: nextPage });
        if (result.connected !== false) {
          setMrs(prev => [...prev, ...(result.mrs ?? [])]);
          setPage(result.page ?? nextPage);
          setHasMore(Boolean(result.hasMore));
        }
      }
    } catch {
      // Silently fail on load more errors
    } finally {
      setLoadingMore(false);
    }
  }, [projectDirectory, gitlab, activeTab, page, hasMore, loading, loadingMore, debouncedSearchQuery]);

  // Reset state when dialog opens/closes
  React.useEffect(() => {
    if (!open) {
      setActiveTab('issues');
      setSearchQuery('');
      setIssues([]);
      setMrs([]);
      setSelectedIssue(null);
      setSelectedMr(null);
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
            ? 'session.gitlabIntegration.validation.branchAlreadyExists'
            : 'session.gitlabIntegration.validation.branchAlreadyCheckedOut')
          : null,
      }));
    } catch {
      setValidations(prev => new Map(prev).set(branchName, {
        isValid: false,
        error: t('session.gitlabIntegration.validation.failed'),
      }));
    }
  }, [projectRef, validations, t]);

  // Validate MR branches when loaded
  React.useEffect(() => {
    if (!open || activeTab !== 'mrs') return;
    
    mrs.forEach(mr => {
      if (mr.sourceBranch) {
        void validateBranch(mr.sourceBranch);
      }
    });
  }, [open, activeTab, mrs, validateBranch]);

  // GitLab connection check
  const isGitLabConnected = gitlabAuthChecked && gitlabAuthStatus?.connected === true;

  const openGitLabSettings = () => {
    setSettingsPage('git');
    setSettingsDialogOpen(true);
  };

  // Handle selection
  const handleSelectIssue = (issue: GitLabIssueSummary) => {
    setSelectedIssue(issue);
    setSelectedMr(null);
  };

  const handleSelectMr = (mr: GitLabMergeRequestSummary) => {
    setSelectedMr(mr);
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
    } else if (selectedMr) {
      onSelect({
        type: 'mr',
        number: selectedMr.number,
        title: selectedMr.title,
        url: selectedMr.url,
        sourceBranch: selectedMr.sourceBranch,
        includeDiff,
      });
    }
    onOpenChange(false);
  };

  const handleClear = () => {
    setSelectedIssue(null);
    setSelectedMr(null);
    setIncludeDiff(false);
  };

  // Check if selection is valid
  const canConfirm = selectedIssue || (selectedMr && validations.get(selectedMr.sourceBranch)?.isValid !== false);

  // Check if MR is blocked
  const isMrBlocked = (mr: GitLabMergeRequestSummary): boolean => {
    if (!mr.sourceBranch) return true;
    const validation = validations.get(mr.sourceBranch);
    return validation?.isValid === false;
  };

  // Content for the dialog (shared between mobile and desktop)
  const dialogContent = (
    <>
      {!isGitLabConnected ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 gap-4">
          <Icon name="git-branch" className="h-12 w-12 text-muted-foreground" />
          <div className="text-center">
            <p className="typography-ui-label text-foreground">{t('session.gitlabIntegration.connect.title')}</p>
            <p className="typography-small text-muted-foreground mt-1">
              {t('session.gitlabIntegration.connect.description')}
            </p>
          </div>
          <Button onClick={openGitLabSettings} size="sm">{t('session.gitlabIntegration.connect.action')}</Button>
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
                ? t('session.gitlabIntegration.search.issuesPlaceholder')
                : t('session.gitlabIntegration.search.mrsPlaceholder')}
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
                      {t('session.gitlabIntegration.empty.noIssuesFound')}
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
                        {t('session.gitlabIntegration.actions.loadMore')}
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

              {/* MRs List */}
              {!loading && !error && activeTab === 'mrs' && (
                <div className="space-y-0.5 min-h-full">
                  {mrs.length > 0 ? (
                    mrs.map(mr => {
                      const blocked = isMrBlocked(mr);
                      const validation = mr.sourceBranch ? validations.get(mr.sourceBranch) : undefined;
                      
                      return (
                        <button
                          key={mr.number}
                          onClick={() => !blocked && handleSelectMr(mr)}
                          disabled={blocked}
                          className={cn(
                            'w-full text-left px-2 py-1.5 rounded transition-colors',
                            selectedMr?.number === mr.number
                              ? 'bg-interactive-selection text-interactive-selection-foreground'
                              : blocked
                                ? 'opacity-50 cursor-not-allowed'
                                : 'hover:bg-interactive-hover'
                          )}
                        >
                          <div className="flex items-start gap-2">
                            <span className="text-muted-foreground shrink-0 typography-micro">!{mr.number}</span>
                            <div className="min-w-0 flex-1">
                              <span className="typography-small line-clamp-1">{mr.title}</span>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="typography-micro text-muted-foreground">
                                  {mr.sourceBranch} → {mr.targetBranch}
                                </span>
                                {mr.draft && (
                                  <span className="typography-micro px-1 py-0.5 rounded bg-status-info/10 text-status-info">
                                    {t('session.gitlabIntegration.draftBadge')}
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
                      {t('session.gitlabIntegration.empty.noMergeRequestsFound')}
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
                        {t('session.gitlabIntegration.actions.loadMore')}
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
        {/* Selected Issue/MR display - hidden on mobile (shown in header instead) */}
        {!isMobile && (selectedIssue || selectedMr) && (
          <div className="flex items-center gap-2 px-2 h-8 rounded-md bg-muted/50 border border-border/50">
            <Icon name="check" className="h-3.5 w-3.5 text-status-success shrink-0" />
            <span className="typography-small truncate max-w-[150px]">
              {selectedIssue
                ? t('session.gitlabIntegration.selected.issueNumber', { number: selectedIssue.number })
                : t('session.gitlabIntegration.selected.mrNumber', { number: selectedMr?.number ?? '' })}
            </span>
            <button
              onClick={handleClear}
              className="text-muted-foreground hover:text-foreground shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
            >
              <Icon name="close" className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        
        {/* Include Diff Checkbox - only show when MR tab is active and MR is selected */}
        {activeTab === 'mrs' && selectedMr && (
          <label className="flex items-center gap-2 cursor-pointer h-8">
            <Checkbox
              checked={includeDiff}
              onChange={(checked) => setIncludeDiff(checked)}
              ariaLabel={t('session.gitlabIntegration.includeDiffAria')}
            />
            <span className="typography-small text-foreground">
              {t('session.gitlabIntegration.includeDiff')}
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
          {t('session.gitlabIntegration.actions.cancel')}
        </Button>
        <Button
          size="sm"
          onClick={handleConfirm}
          disabled={!canConfirm}
          className={cn(isMobile && 'flex-1')}
        >
          {t('session.gitlabIntegration.actions.select')}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      {isMobile ? (
        <MobileOverlayPanel
          open={open}
          title={t('session.gitlabIntegration.title')}
          onClose={() => onOpenChange(false)}
          footer={!isGitLabConnected ? undefined : footerContent}
          renderHeader={(closeButton) => (
            <div className="flex flex-col gap-2 px-3 py-2 border-b border-border/40">
              <div className="flex items-center justify-between">
                <h2 className="typography-ui-label font-semibold text-foreground">{t('session.gitlabIntegration.title')}</h2>
                {closeButton}
              </div>
              {/* Tabs - using SortableTabsStrip */}
              <div className="w-full">
                <SortableTabsStrip
                  items={[
                    { id: 'issues', label: t('session.gitlabIntegration.tabs.issues'), icon: <Icon name="git-branch" className="h-3.5 w-3.5" /> },
                    { id: 'mrs', label: t('session.gitlabIntegration.tabs.mergeRequests'), icon: <Icon name="git-merge" className="h-3.5 w-3.5" /> },
                  ]}
                  activeId={activeTab}
                  onSelect={(id) => {
                    setActiveTab(id as GitLabTab);
                    setSearchQuery('');
                  }}
                  variant="active-pill"
                  layoutMode="fit"
                />
              </div>
              
              {/* Selected Item Inline Display */}
              {(selectedIssue || selectedMr) && (
                <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-muted/50 border border-border/50">
                  <Icon name="check" className="h-3.5 w-3.5 text-status-success shrink-0" />
                  <span className="typography-small truncate flex-1">
                    {selectedIssue
                      ? t('session.gitlabIntegration.selected.issueNumber', { number: selectedIssue.number })
                      : t('session.gitlabIntegration.selected.mrNumber', { number: selectedMr?.number ?? '' })}
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
                  <Icon name="git-branch" className="h-5 w-5" />
                  {t('session.gitlabIntegration.title')}
                </DialogTitle>
                
                {/* Tabs - using SortableTabsStrip */}
                <div className="w-[220px]">
                  <SortableTabsStrip
                    items={[
                      { id: 'issues', label: t('session.gitlabIntegration.tabs.issues'), icon: <Icon name="git-branch" className="h-3.5 w-3.5" /> },
                      { id: 'mrs', label: t('session.gitlabIntegration.tabs.mergeRequests'), icon: <Icon name="git-merge" className="h-3.5 w-3.5" /> },
                    ]}
                    activeId={activeTab}
                    onSelect={(id) => {
                      setActiveTab(id as GitLabTab);
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
