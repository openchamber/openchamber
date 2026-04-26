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
import {
  RiGithubLine,
  RiLoader4Line,
  RiSearchLine,
  RiErrorWarningLine,
  RiCheckLine,
  RiGitPullRequestLine,
  RiGitBranchLine,
  RiCloseLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { validateWorktreeCreate } from '@/lib/worktrees/worktreeManager';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import type {
  GitHubIssue,
  GitHubIssueSummary,
  GitHubPullRequestSummary,
} from '@/lib/api/types';
import type { ProjectRef } from '@/lib/worktrees/worktreeManager';
import { useI18n } from '@/lib/i18n';

type GitHubTab = 'issues' | 'prs';

interface GitHubIntegrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (result: {
    type: 'issue' | 'pr';
    item: GitHubIssue | GitHubPullRequestSummary;
    includeDiff?: boolean;
  } | null) => void;
}

interface ValidationResult {
  isValid: boolean;
  error: string | null;
}

export function GitHubIntegrationDialog({
  open,
  onOpenChange,
  onSelect,
}: GitHubIntegrationDialogProps) {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const { github } = useRuntimeAPIs();
  const githubAuthStatus = useGitHubAuthStore((state) => state.status);
  const githubAuthChecked = useGitHubAuthStore((state) => state.hasChecked);
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
  const [activeTab, setActiveTab] = React.useState<GitHubTab>('issues');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [issues, setIssues] = React.useState<GitHubIssueSummary[]>([]);
  const [prs, setPrs] = React.useState<GitHubPullRequestSummary[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = React.useState<GitHubIssue | null>(null);
  const [selectedPr, setSelectedPr] = React.useState<GitHubPullRequestSummary | null>(null);
  const [includeDiff, setIncludeDiff] = React.useState(false);
  const [validations, setValidations] = React.useState<Map<string, ValidationResult>>(new Map());
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);

  // Load GitHub data
  const loadData = React.useCallback(async () => {
    if (!projectDirectory || !github) return;
    if (githubAuthChecked && githubAuthStatus?.connected === false) return;
    
    setLoading(true);
    setError(null);
    setPage(1);
    setHasMore(false);
    
    try {
      if (activeTab === 'issues' && github.issuesList) {
        const result = await github.issuesList(projectDirectory, { page: 1 });
        if (result.connected === false) {
          setError(t('session.githubIntegration.error.notConnected'));
          setIssues([]);
        } else {
          setIssues(result.issues ?? []);
          setPage(result.page ?? 1);
          setHasMore(Boolean(result.hasMore));
        }
      } else if (activeTab === 'prs' && github.prsList) {
        const result = await github.prsList(projectDirectory, { page: 1 });
        if (result.connected === false) {
          setError(t('session.githubIntegration.error.notConnected'));
          setPrs([]);
        } else {
          setPrs(result.prs ?? []);
          setPage(result.page ?? 1);
          setHasMore(Boolean(result.hasMore));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('session.githubIntegration.error.loadDataFailed'));
    } finally {
      setLoading(false);
    }
  }, [projectDirectory, github, githubAuthChecked, githubAuthStatus, activeTab, t]);

  // Load more data
  const loadMore = React.useCallback(async () => {
    if (!projectDirectory || !github) return;
    if (loading || loadingMore) return;
    if (!hasMore) return;
    
    setLoadingMore(true);
    
    try {
      const nextPage = page + 1;
      
      if (activeTab === 'issues' && github.issuesList) {
        const result = await github.issuesList(projectDirectory, { page: nextPage });
        if (result.connected !== false) {
          setIssues(prev => [...prev, ...(result.issues ?? [])]);
          setPage(result.page ?? nextPage);
          setHasMore(Boolean(result.hasMore));
        }
      } else if (activeTab === 'prs' && github.prsList) {
        const result = await github.prsList(projectDirectory, { page: nextPage });
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
  }, [projectDirectory, github, activeTab, page, hasMore, loading, loadingMore]);

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
      
      const isBlocked = result.errors.some(
        (entry) => entry.code === 'branch_in_use' || entry.code === 'branch_exists'
      );
      
      setValidations(prev => new Map(prev).set(branchName, {
        isValid: !isBlocked,
        error: isBlocked ? t('session.githubIntegration.validation.branchAlreadyCheckedOut') : null,
      }));
    } catch {
      setValidations(prev => new Map(prev).set(branchName, {
        isValid: false,
        error: t('session.githubIntegration.validation.failed'),
      }));
    }
  }, [projectRef, validations, t]);

  // Validate PR branches when loaded
  React.useEffect(() => {
    if (!open || activeTab !== 'prs') return;
    
    prs.forEach(pr => {
      if (pr.head) {
        void validateBranch(pr.head);
      }
    });
  }, [open, activeTab, prs, validateBranch]);

  // Filtered results
  const filteredIssues = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return issues;
    return issues.filter(issue => {
      if (String(issue.number) === q.replace(/^#/, '')) return true;
      return issue.title.toLowerCase().includes(q);
    });
  }, [issues, searchQuery]);

  const filteredPrs = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return prs;
    return prs.filter(pr => {
      if (String(pr.number) === q.replace(/^#/, '')) return true;
      return pr.title.toLowerCase().includes(q);
    });
  }, [prs, searchQuery]);

  // GitHub connection check
  const isGitHubConnected = githubAuthChecked && githubAuthStatus?.connected === true;

  const openGitHubSettings = () => {
    setSettingsPage('github');
    setSettingsDialogOpen(true);
  };

  // Handle selection
  const handleSelectIssue = (issue: GitHubIssueSummary) => {
    setSelectedIssue(issue as GitHubIssue);
    setSelectedPr(null);
  };

  const handleSelectPr = (pr: GitHubPullRequestSummary) => {
    setSelectedPr(pr);
    setSelectedIssue(null);
  };

  const handleConfirm = () => {
    if (selectedIssue) {
      onSelect({
        type: 'issue',
        item: selectedIssue,
      });
    } else if (selectedPr) {
      onSelect({
        type: 'pr',
        item: selectedPr,
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
  const canConfirm = selectedIssue || (selectedPr && validations.get(selectedPr.head ?? '')?.isValid !== false);

  // Check if PR is blocked
  const isPrBlocked = (pr: GitHubPullRequestSummary): boolean => {
    if (!pr.head) return true;
    const validation = validations.get(pr.head);
    return validation?.isValid === false;
  };

  // Content for the dialog (shared between mobile and desktop)
  const dialogContent = (
    <>
      {!isGitHubConnected ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 gap-4">
          <RiGithubLine className="h-12 w-12 text-muted-foreground" />
          <div className="text-center">
            <p className="typography-ui-label text-foreground">{t('session.githubIntegration.connect.title')}</p>
            <p className="typography-small text-muted-foreground mt-1">
              {t('session.githubIntegration.connect.description')}
            </p>
          </div>
          <Button onClick={openGitHubSettings} size="sm">{t('session.githubIntegration.connect.action')}</Button>
        </div>
      ) : (
        <>
          {/* Search */}
          <div className="relative mt-2">
            <RiSearchLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={activeTab === 'issues'
                ? t('session.githubIntegration.search.issuesPlaceholder')
                : t('session.githubIntegration.search.prsPlaceholder')}
              className="h-8 pl-9"
            />
          </div>

          {/* List Content */}
          <div className="mt-2 h-[300px] overflow-hidden">
            <div className="h-full overflow-y-auto">
              {/* Loading */}
              {loading && (
                <div className="flex items-center justify-center h-full">
                  <RiLoader4Line className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="flex items-center justify-center h-full">
                  <div className="flex items-center gap-2 p-2 rounded-md bg-destructive/10 text-destructive">
                    <RiErrorWarningLine className="h-4 w-4" />
                    <span className="typography-small">{error}</span>
                  </div>
                </div>
              )}

              {/* Issues List */}
              {!loading && !error && activeTab === 'issues' && (
                <div className="space-y-0.5 min-h-full">
                  {filteredIssues.length > 0 ? (
                    filteredIssues.map(issue => (
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
                          <span className="typography-small line-clamp-2">{issue.title}</span>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="flex items-center justify-center h-[300px] text-center typography-small text-muted-foreground">
                      {t('session.githubIntegration.empty.noIssuesFound')}
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
                        {t('session.githubIntegration.actions.loadMore')}
                      </Button>
                    </div>
                  )}
                  {loadingMore && (
                    <div className="flex items-center justify-center py-2">
                      <RiLoader4Line className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  )}
                </div>
              )}

              {/* PRs List */}
              {!loading && !error && activeTab === 'prs' && (
                <div className="space-y-0.5 min-h-full">
                  {filteredPrs.length > 0 ? (
                    filteredPrs.map(pr => {
                      const blocked = isPrBlocked(pr);
                      const validation = pr.head ? validations.get(pr.head) : undefined;
                      
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
                                  {pr.head} → {pr.base}
                                </span>
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
                      {t('session.githubIntegration.empty.noPullRequestsFound')}
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
                        {t('session.githubIntegration.actions.loadMore')}
                      </Button>
                    </div>
                  )}
                  {loadingMore && (
                    <div className="flex items-center justify-center py-2">
                      <RiLoader4Line className="h-4 w-4 animate-spin text-muted-foreground" />
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
            <RiCheckLine className="h-3.5 w-3.5 text-status-success shrink-0" />
            <span className="typography-small truncate max-w-[150px]">
              {selectedIssue
                ? t('session.githubIntegration.selected.issueNumber', { number: selectedIssue.number })
                : t('session.githubIntegration.selected.prNumber', { number: selectedPr?.number ?? '' })}
            </span>
            <button
              onClick={handleClear}
              className="text-muted-foreground hover:text-foreground shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
            >
              <RiCloseLine className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        
        {/* Include Diff Checkbox - only show when PR tab is active and PR is selected */}
        {activeTab === 'prs' && selectedPr && (
          <label className="flex items-center gap-2 cursor-pointer h-8">
            <Checkbox
              checked={includeDiff}
              onChange={(checked) => setIncludeDiff(checked)}
              ariaLabel={t('session.githubIntegration.includeDiffAria')}
            />
            <span className="typography-small text-foreground">
              {t('session.githubIntegration.includeDiff')}
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
          {t('session.githubIntegration.actions.cancel')}
        </Button>
        <Button
          size="sm"
          onClick={handleConfirm}
          disabled={!canConfirm}
          className={cn(isMobile && 'flex-1')}
        >
          {t('session.githubIntegration.actions.select')}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      {isMobile ? (
        <MobileOverlayPanel
          open={open}
          title={t('session.githubIntegration.title')}
          onClose={() => onOpenChange(false)}
          footer={!isGitHubConnected ? undefined : footerContent}
          renderHeader={(closeButton) => (
            <div className="flex flex-col gap-2 px-3 py-2 border-b border-border/40">
              <div className="flex items-center justify-between">
                <h2 className="typography-ui-label font-semibold text-foreground">{t('session.githubIntegration.title')}</h2>
                {closeButton}
              </div>
              {/* Tabs - using SortableTabsStrip */}
              <div className="w-full">
                <SortableTabsStrip
                  items={[
                    { id: 'issues', label: t('session.githubIntegration.tabs.issues'), icon: <RiGitBranchLine className="h-3.5 w-3.5" /> },
                    { id: 'prs', label: t('session.githubIntegration.tabs.pullRequests'), icon: <RiGitPullRequestLine className="h-3.5 w-3.5" /> },
                  ]}
                  activeId={activeTab}
                  onSelect={(id) => {
                    setActiveTab(id as GitHubTab);
                    setSearchQuery('');
                  }}
                  variant="active-pill"
                  layoutMode="fit"
                />
              </div>
              
              {/* Selected Item Inline Display */}
              {(selectedIssue || selectedPr) && (
                <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-muted/50 border border-border/50">
                  <RiCheckLine className="h-3.5 w-3.5 text-status-success shrink-0" />
                  <span className="typography-small truncate flex-1">
                    {selectedIssue
                      ? t('session.githubIntegration.selected.issueNumber', { number: selectedIssue.number })
                      : t('session.githubIntegration.selected.prNumber', { number: selectedPr?.number ?? '' })}
                  </span>
                  <button
                    onClick={handleClear}
                    className="text-muted-foreground hover:text-foreground shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
                  >
                    <RiCloseLine className="h-3.5 w-3.5" />
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
                  <RiGithubLine className="h-5 w-5" />
                  {t('session.githubIntegration.title')}
                </DialogTitle>
                
                {/* Tabs - using SortableTabsStrip */}
                <div className="w-[220px]">
                  <SortableTabsStrip
                    items={[
                      { id: 'issues', label: t('session.githubIntegration.tabs.issues'), icon: <RiGitBranchLine className="h-3.5 w-3.5" /> },
                      { id: 'prs', label: t('session.githubIntegration.tabs.pullRequests'), icon: <RiGitPullRequestLine className="h-3.5 w-3.5" /> },
                    ]}
                    activeId={activeTab}
                    onSelect={(id) => {
                      setActiveTab(id as GitHubTab);
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
