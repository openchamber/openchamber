import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
  RiGithubLine,
  RiLoader4Line,
  RiSearchLine,
  RiErrorWarningLine,
  RiCheckLine,
  RiExternalLinkLine,
  RiGitPullRequestLine,
  RiGitBranchLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { validateWorktreeCreate } from '@/lib/worktrees/worktreeManager';
import type {
  GitHubIssue,
  GitHubIssueSummary,
  GitHubPullRequestSummary,
} from '@/lib/api/types';
import type { ProjectRef } from '@/lib/worktrees/worktreeManager';

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
          setError('GitHub not connected');
          setIssues([]);
        } else {
          setIssues(result.issues ?? []);
          setPage(result.page ?? 1);
          setHasMore(Boolean(result.hasMore));
        }
      } else if (activeTab === 'prs' && github.prsList) {
        const result = await github.prsList(projectDirectory, { page: 1 });
        if (result.connected === false) {
          setError('GitHub not connected');
          setPrs([]);
        } else {
          setPrs(result.prs ?? []);
          setPage(result.page ?? 1);
          setHasMore(Boolean(result.hasMore));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [projectDirectory, github, githubAuthChecked, githubAuthStatus, activeTab]);

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
        error: isBlocked ? 'Branch is already checked out in a worktree' : null,
      }));
    } catch {
      setValidations(prev => new Map(prev).set(branchName, {
        isValid: false,
        error: 'Validation failed',
      }));
    }
  }, [projectRef, validations]);

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
    onSelect(null);
  };

  // Check if selection is valid
  const canConfirm = selectedIssue || (selectedPr && validations.get(selectedPr.head ?? '')?.isValid !== false);

  // Check if PR is blocked
  const isPrBlocked = (pr: GitHubPullRequestSummary): boolean => {
    if (!pr.head) return true;
    const validation = validations.get(pr.head);
    return validation?.isValid === false;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0">
        <DialogHeader className="flex-shrink-0 px-6 pt-6 pb-4 border-b border-border/50">
          <DialogTitle className="flex items-center gap-2 typography-ui-header font-semibold">
            <RiGithubLine className="h-5 w-5" />
            Select from GitHub
          </DialogTitle>
          <DialogDescription className="typography-small text-muted-foreground">
            Choose an issue or pull request to link to your worktree
          </DialogDescription>
        </DialogHeader>

        {!isGitHubConnected ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 gap-4">
            <RiGithubLine className="h-12 w-12 text-muted-foreground" />
            <div className="text-center">
              <p className="typography-ui-label text-foreground">Connect to GitHub</p>
              <p className="typography-small text-muted-foreground mt-1">
                Link issues or pull requests to auto-fill worktree details
              </p>
            </div>
            <Button onClick={openGitHubSettings}>Connect GitHub</Button>
          </div>
        ) : (
          <>
            {/* Tabs */}
            <div className="flex-shrink-0 px-6 py-3 border-b border-border/50">
              <div className="flex items-center gap-1 p-1 bg-muted rounded-lg w-fit">
                <button
                  onClick={() => {
                    setActiveTab('issues');
                    setSearchQuery('');
                  }}
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5 rounded-md typography-ui-label transition-all',
                    activeTab === 'issues'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted-foreground/5'
                  )}
                >
                  <RiGitBranchLine className="h-4 w-4" />
                  Issues
                </button>
                <button
                  onClick={() => {
                    setActiveTab('prs');
                    setSearchQuery('');
                  }}
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5 rounded-md typography-ui-label transition-all',
                    activeTab === 'prs'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted-foreground/5'
                  )}
                >
                  <RiGitPullRequestLine className="h-4 w-4" />
                  Pull Requests
                </button>
              </div>
            </div>

            <ScrollableOverlay className="flex-1 px-6 py-4">
              <div className="space-y-4">
                {/* Search */}
                <div className="relative">
                  <RiSearchLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={activeTab === 'issues' ? "Search issues or enter #123..." : "Search PRs or enter #456..."}
                    className="h-9 pl-9"
                  />
                </div>

                {/* Loading */}
                {loading && (
                  <div className="flex items-center justify-center py-8">
                    <RiLoader4Line className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                )}

                {/* Error */}
                {error && (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive">
                    <RiErrorWarningLine className="h-4 w-4" />
                    <span className="typography-small">{error}</span>
                  </div>
                )}

                {/* Issues List */}
                {!loading && !error && activeTab === 'issues' && (
                  <>
                    <ScrollableOverlay className="max-h-[300px] border border-border/50 rounded-lg">
                      <div className="p-1 space-y-0.5">
                        {filteredIssues.length > 0 ? (
                          filteredIssues.map(issue => (
                            <button
                              key={issue.number}
                              onClick={() => handleSelectIssue(issue)}
                              className={cn(
                                'w-full text-left px-3 py-2.5 rounded-md transition-colors',
                                selectedIssue?.number === issue.number
                                  ? 'bg-interactive-selection text-interactive-selection-foreground'
                                  : 'hover:bg-interactive-hover'
                              )}
                            >
                              <div className="flex items-start gap-2">
                                <span className="text-muted-foreground shrink-0 typography-small">#{issue.number}</span>
                                <span className="typography-small line-clamp-2">{issue.title}</span>
                              </div>
                            </button>
                          ))
                        ) : (
                          <div className="px-3 py-8 text-center typography-small text-muted-foreground">
                            No issues found
                          </div>
                        )}
                      </div>
                    </ScrollableOverlay>
                    {hasMore && !loadingMore && (
                      <div className="flex justify-center pt-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void loadMore()}
                        >
                          Load more
                        </Button>
                      </div>
                    )}
                    {loadingMore && (
                      <div className="flex items-center justify-center py-2">
                        <RiLoader4Line className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    )}
                  </>
                )}

                {/* PRs List */}
                {!loading && !error && activeTab === 'prs' && (
                  <>
                    <ScrollableOverlay className="max-h-[300px] border border-border/50 rounded-lg">
                      <div className="p-1 space-y-0.5">
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
                                  'w-full text-left px-3 py-2.5 rounded-md transition-colors',
                                  selectedPr?.number === pr.number
                                    ? 'bg-interactive-selection text-interactive-selection-foreground'
                                    : blocked
                                      ? 'opacity-50 cursor-not-allowed'
                                      : 'hover:bg-interactive-hover'
                                )}
                              >
                                <div className="flex items-start gap-2">
                                  <span className="text-muted-foreground shrink-0 typography-small">#{pr.number}</span>
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
                          <div className="px-3 py-8 text-center typography-small text-muted-foreground">
                            No pull requests found
                          </div>
                        )}
                      </div>
                    </ScrollableOverlay>
                    {hasMore && !loadingMore && (
                      <div className="flex justify-center pt-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void loadMore()}
                        >
                          Load more
                        </Button>
                      </div>
                    )}
                    {loadingMore && (
                      <div className="flex items-center justify-center py-2">
                        <RiLoader4Line className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    )}
                  </>
                )}

                {/* Selected Item Preview */}
                {(selectedIssue || selectedPr) && (
                  <div className="p-3 rounded-lg bg-muted/50 border border-border/50">
                    <div className="flex items-start gap-2">
                      <RiCheckLine className="h-4 w-4 text-status-success shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        {selectedIssue && (
                          <>
                            <div className="flex items-center gap-2">
                              <span className="typography-small font-medium">
                                Issue #{selectedIssue.number}
                              </span>
                              <a
                                href={selectedIssue.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <RiExternalLinkLine className="h-3 w-3" />
                              </a>
                            </div>
                            <p className="typography-small text-muted-foreground line-clamp-1">
                              {selectedIssue.title}
                            </p>
                            <p className="typography-micro text-muted-foreground mt-1">
                              Branch will be: issue-{selectedIssue.number}-{'<slug>'}
                            </p>
                          </>
                        )}
                        {selectedPr && (
                          <>
                            <div className="flex items-center gap-2">
                              <span className="typography-small font-medium">
                                PR #{selectedPr.number}
                              </span>
                              <span className="typography-micro text-muted-foreground">
                                {selectedPr.head} → {selectedPr.base}
                              </span>
                              <a
                                href={selectedPr.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <RiExternalLinkLine className="h-3 w-3" />
                              </a>
                            </div>
                            <p className="typography-small text-muted-foreground line-clamp-1">
                              {selectedPr.title}
                            </p>
                            
                            {/* Include Diff Checkbox */}
                            <div className="mt-3 pt-3 border-t border-border/30">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <Checkbox
                                  checked={includeDiff}
                                  onChange={(checked) => setIncludeDiff(checked)}
                                  ariaLabel="Include PR diff in context"
                                />
                                <span className="typography-small text-foreground">
                                  Include PR diff in session context
                                </span>
                              </label>
                            </div>
                          </>
                        )}
                      </div>
                      <button
                        onClick={handleClear}
                        className="text-muted-foreground hover:text-foreground shrink-0"
                      >
                        <span className="sr-only">Clear selection</span>
                        ×
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </ScrollableOverlay>

            {/* Footer */}
            <DialogFooter className="flex-shrink-0 px-6 py-4 border-t border-border/50">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={!canConfirm}
              >
                Select
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
