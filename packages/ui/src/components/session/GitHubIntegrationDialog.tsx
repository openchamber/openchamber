import * as React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
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
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useOpenSourceControlSettings } from '@/hooks/useOpenSourceControlSettings';
import { getSourceControlAuthKey, getSourceControlReadContextAuthState, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import {
  appendMissingSourceControlItems,
  GITHUB_SOURCE_CONTROL_IDENTITY,
  mergeIncompleteSourceControlPage,
} from '@/lib/source-control/identity';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { validateWorktreeCreate } from '@/lib/worktrees/worktreeManager';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Icon } from "@/components/icon/Icon";
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type {
  ChangeRequest,
  Issue,
  SourceControlReadContext,
} from '@/lib/api/types';
import type { ProjectRef } from '@/lib/worktrees/worktreeManager';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createBranchValidationRequests } from './branchValidationRequests';

type GitHubTab = 'issues' | 'prs';

export type GitHubWorktreeSelection =
  | { type: 'issue'; item: Issue; context: SourceControlReadContext }
  | { type: 'pr'; item: ChangeRequest; context: SourceControlReadContext; includeDiff?: boolean };

interface GitHubIntegrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (result: GitHubWorktreeSelection | null) => void;
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
  const openSourceControlSettings = useOpenSourceControlSettings();
  const { sourceControl } = useRuntimeAPIs();
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
  const [issues, setIssues] = React.useState<Issue[]>([]);
  const [prs, setPrs] = React.useState<ChangeRequest[]>([]);
  const [loading, setLoading] = React.useState(false);
  const binding = useRepositoryBinding(projectDirectory, sourceControl, open);
  const isBindingCurrent = binding.isCurrent;
  const resolvingIssueContext = binding.status === 'loading';
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [requestError, setError] = React.useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = React.useState<Issue | null>(null);
  const [selectedPr, setSelectedPr] = React.useState<{
    item: ChangeRequest;
    context: SourceControlReadContext;
  } | null>(null);
  const [includeDiff, setIncludeDiff] = React.useState(false);
  const [validationState, setValidationState] = React.useState<{
    scope: string;
    values: Map<string, ValidationResult>;
  }>({ scope: '', values: new Map() });
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const operationGenerationRef = React.useRef(0);
  const [validationRequests] = React.useState(createBranchValidationRequests);
  const validationScope = JSON.stringify([getRuntimeKey(), projectRef?.id ?? null, projectRef?.path ?? null]);
  validationRequests.setScope(validationScope);
  const validations = React.useMemo(
    () => validationState.scope === validationScope ? validationState.values : new Map<string, ValidationResult>(),
    [validationScope, validationState],
  );

  const debouncedSearchQuery = useDebouncedValue(searchQuery, 350);
  const readContext = binding.contexts.find((context) => context.provider === GITHUB_SOURCE_CONTROL_IDENTITY.provider) ?? null;
  const error = binding.error ? t('session.githubIntegration.error.loadDataFailed')
    : binding.status === 'ready' && !readContext ? t('session.githubIntegration.error.notConnected') : requestError;
  const readAuthEntry = useSourceControlAuthStore((state) => (
    readContext ? state.entries[getSourceControlAuthKey(readContext)] : undefined
  ));
  const boundAccountConnected = readContext
    ? getSourceControlReadContextAuthState(readAuthEntry, readContext).connected
    : false;

  React.useLayoutEffect(() => {
    operationGenerationRef.current += 1;
    setLoading(false);
    setLoadingMore(false);
    return () => {
      operationGenerationRef.current += 1;
    };
  }, [open, projectDirectory, readContext, activeTab, debouncedSearchQuery, sourceControl, boundAccountConnected]);

  React.useLayoutEffect(() => {
    setIssues([]);
    setPrs([]);
    setSelectedIssue(null);
    setSelectedPr(null);
    setPage(1);
    setHasMore(false);
    setError(null);
  }, [open, readContext, boundAccountConnected]);

  const loadData = React.useCallback(async (query?: string) => {
    if (!projectDirectory || !isBindingCurrent()) return;
    const context = readContext?.directory === projectDirectory ? readContext : null;
    if (!context || !boundAccountConnected) return;

    const operationGeneration = operationGenerationRef.current;
    
    setLoading(true);
    setError(null);
    setPage(1);
    setHasMore(false);
    
    try {
      if (activeTab === 'issues') {
        const result = await sourceControl.issuesList(context, { page: 1, query });
        if (!isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;
        setIssues((previous) => mergeIncompleteSourceControlPage(previous, result));
        setPage(result.page);
        setHasMore(result.hasMore);
      } else {
        const result = await sourceControl.changeRequestsList(context, { page: 1, query });
        if (!isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;
        setPrs((previous) => mergeIncompleteSourceControlPage(previous, result));
        setPage(result.page);
        setHasMore(result.hasMore);
      }
    } catch (err) {
      if (operationGeneration !== operationGenerationRef.current) return;
      if (!isBindingCurrent()) return;
      setError(err instanceof Error ? err.message : t('session.githubIntegration.error.loadDataFailed'));
    } finally {
      if (isBindingCurrent() && operationGeneration === operationGenerationRef.current) setLoading(false);
    }
  }, [projectDirectory, activeTab, boundAccountConnected, isBindingCurrent, readContext, sourceControl, t]);

  React.useEffect(() => {
    if (!open || !projectDirectory) return;
    const context = readContext?.directory === projectDirectory ? readContext : null;
    if (!context || !boundAccountConnected) return;
    void loadData(debouncedSearchQuery.trim() || undefined);
  }, [open, projectDirectory, activeTab, debouncedSearchQuery, boundAccountConnected, readContext, loadData]);

  const loadMore = React.useCallback(async () => {
    if (!projectDirectory || !isBindingCurrent()) return;
    const context = readContext?.directory === projectDirectory ? readContext : null;
    if (!context || !boundAccountConnected) return;
    if (loading || loadingMore) return;
    if (!hasMore) return;
    
    setLoadingMore(true);
    const operationGeneration = operationGenerationRef.current;
    
    try {
      const nextPage = page + 1;
      
      if (activeTab === 'issues') {
        const result = debouncedSearchQuery.trim()
          ? await sourceControl.issuesList(context, { page: nextPage, query: debouncedSearchQuery.trim() })
          : await sourceControl.issuesList(context, { page: nextPage });
        if (!isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;
        setIssues((previous) => appendMissingSourceControlItems(previous, result.items));
        if (result.incompleteProjectIds?.length) {
          setHasMore(true);
        } else {
          setPage(result.page);
          setHasMore(result.hasMore);
        }
      } else {
        const result = debouncedSearchQuery.trim()
          ? await sourceControl.changeRequestsList(context, { page: nextPage, query: debouncedSearchQuery.trim() })
          : await sourceControl.changeRequestsList(context, { page: nextPage });
        if (!isBindingCurrent() || operationGeneration !== operationGenerationRef.current) return;
        setPrs((previous) => appendMissingSourceControlItems(previous, result.items));
        if (result.incompleteProjectIds?.length) {
          setHasMore(true);
        } else {
          setPage(result.page);
          setHasMore(result.hasMore);
        }
      }
    } catch {
      // Silently fail on load more errors
    } finally {
      if (isBindingCurrent() && operationGeneration === operationGenerationRef.current) setLoadingMore(false);
    }
  }, [projectDirectory, activeTab, boundAccountConnected, isBindingCurrent, readContext, page, hasMore, loading, loadingMore, debouncedSearchQuery, sourceControl]);

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
      setValidationState({ scope: validationScope, values: new Map() });
      setPage(1);
      setHasMore(false);
      return;
    }
    
  }, [open, validationScope]);

  React.useEffect(() => {
    setValidationState({ scope: validationScope, values: new Map() });
  }, [validationScope]);

  // Validate branches for worktree creation
  const validateBranch = React.useCallback(async (branchName: string) => {
    if (!projectRef || !branchName) return;
    if (validations.has(branchName)) return;

    const requestToken = validationRequests.begin(validationScope, branchName);
    if (!requestToken) return;
    const capturedRuntimeKey = getRuntimeKey();
    try {
      const result = await validateWorktreeCreate(projectRef, {
        mode: 'new',
        branchName,
        worktreeName: branchName,
      });
      
      const blockingError = result.errors.find((entry) => entry.code === 'branch_in_use');
      if (
        capturedRuntimeKey !== getRuntimeKey()
        || !validationRequests.isCurrent(validationScope, branchName, requestToken)
      ) return;
      setValidationState((previous) => ({
        scope: validationScope,
        values: new Map(previous.scope === validationScope ? previous.values : []).set(branchName, {
          isValid: !blockingError,
          error: blockingError
            ? t(blockingError.code === 'branch_exists'
              ? 'session.githubIntegration.validation.branchAlreadyExists'
              : 'session.githubIntegration.validation.branchAlreadyCheckedOut')
            : null,
        }),
      }));
    } catch {
      if (
        capturedRuntimeKey !== getRuntimeKey()
        || !validationRequests.isCurrent(validationScope, branchName, requestToken)
      ) return;
      setValidationState((previous) => ({
        scope: validationScope,
        values: new Map(previous.scope === validationScope ? previous.values : []).set(branchName, {
          isValid: false,
          error: t('session.githubIntegration.validation.failed'),
        }),
      }));
    } finally {
      validationRequests.finish(validationScope, branchName, requestToken);
    }
  }, [projectRef, validationRequests, validationScope, validations, t]);

  // Validate PR branches when loaded
  React.useEffect(() => {
    if (!open || activeTab !== 'prs') return;
    
    prs.forEach(pr => {
      if (pr.head) {
        void validateBranch(pr.head);
      }
    });
  }, [open, activeTab, prs, validateBranch]);

  // GitHub connection check
  const isConnected = boundAccountConnected;
  const contentLoading = loading || resolvingIssueContext || Boolean(readContext && !readAuthEntry?.hasChecked);

  // Handle selection
  const handleSelectIssue = (issue: Issue) => {
    setSelectedIssue(issue);
    setSelectedPr(null);
  };

  const handleSelectPr = (pr: ChangeRequest) => {
    if (!readContext) return;
    setSelectedPr({ item: pr, context: readContext });
    setSelectedIssue(null);
  };

  const handleConfirm = () => {
    if (!boundAccountConnected) return;
    if (selectedIssue && readContext) {
      onSelect({
        type: 'issue',
        item: selectedIssue,
        context: readContext,
      });
    } else if (selectedPr) {
      onSelect({
        type: 'pr',
        item: selectedPr.item,
        context: selectedPr.context,
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

  const handleTabSelect = (id: string) => {
    if (id !== 'issues' && id !== 'prs') return;
    setActiveTab(id);
    setSearchQuery('');
  };

  // Check if selection is valid
  const canConfirm = boundAccountConnected && (selectedIssue || (selectedPr && validations.get(selectedPr.item.head)?.isValid !== false));

  // Check if PR is blocked
  const isPrBlocked = (pr: ChangeRequest): boolean => {
    if (!pr.head) return true;
    const validation = validations.get(pr.head);
    return validation?.isValid === false;
  };

  // Content for the dialog (shared between mobile and desktop)
  const dialogContent = (
    <>
      {binding.error ? (
        <div className="flex flex-col items-center gap-3 p-8 text-center">
          <p className="typography-meta text-muted-foreground">{t('session.githubIntegration.error.loadDataFailed')}</p>
          <Button size="sm" variant="outline" onClick={() => void binding.retry()} disabled={resolvingIssueContext}>
            {t('settings.sourceControl.transport.retry')}
          </Button>
        </div>
      ) : null}
      {!isConnected ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 gap-4">
          <Icon name="github" className="h-12 w-12 text-muted-foreground" />
          <div className="text-center">
            <p className="typography-ui-label text-foreground">{t('session.githubIntegration.connect.title')}</p>
            <p className="typography-small text-muted-foreground mt-1">
              {t('session.githubIntegration.connect.description')}
            </p>
          </div>
          <Button onClick={openSourceControlSettings} size="sm">{t('session.githubIntegration.connect.action')}</Button>
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
                ? t('session.githubIntegration.search.issuesPlaceholder')
                : t('session.githubIntegration.search.prsPlaceholder')}
              className="h-8 pl-9"
            />
          </div>

          {/* List Content */}
          <div className="mt-2 h-[300px] overflow-hidden">
            <ScrollableOverlay outerClassName="h-full" disableHorizontal>
              {/* Loading */}
              {contentLoading && (
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
              {!contentLoading && !error && activeTab === 'issues' && (
                <div className="space-y-0.5 min-h-full">
                  {issues.length > 0 ? (
                    issues.map(issue => (
                      <button
                        key={issue.id}
                        onClick={() => handleSelectIssue(issue)}
                        className={cn(
                          'w-full text-left px-2 py-1.5 rounded transition-colors',
                          selectedIssue?.id === issue.id
                            ? 'bg-interactive-selection text-interactive-selection-foreground'
                            : 'hover:bg-interactive-hover'
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <span className="text-muted-foreground shrink-0 typography-micro">#{issue.number}</span>
                          <div className="min-w-0 flex-1">
                            <span className="typography-small line-clamp-2">{issue.title}</span>
                            {issue.project.remoteName === 'upstream' ? (
                              <span className="typography-micro px-1 py-0.5 rounded bg-status-info/10 text-status-info mt-0.5 inline-block">
                                {issue.project.owner}/{issue.project.name}
                              </span>
                            ) : null}
                          </div>
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
                      <Icon name="loader-4" className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  )}
                </div>
              )}

              {/* PRs List */}
              {!contentLoading && !error && activeTab === 'prs' && (
                <div className="space-y-0.5 min-h-full">
                  {prs.length > 0 ? (
                    prs.map(pr => {
                      const blocked = isPrBlocked(pr);
                      const validation = pr.head ? validations.get(pr.head) : undefined;
                      
                      return (
                        <button
                          key={pr.id}
                          onClick={() => !blocked && handleSelectPr(pr)}
                          disabled={blocked}
                          className={cn(
                            'w-full text-left px-2 py-1.5 rounded transition-colors',
                            selectedPr?.item.id === pr.id
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
                                {pr.project.remoteName === 'upstream' ? (
                                  <span className="typography-micro px-1 py-0.5 rounded bg-status-info/10 text-status-info">
                                    {pr.project.owner}/{pr.project.name}
                                  </span>
                                ) : null}
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
                      <Icon name="loader-4" className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  )}
                </div>
              )}
            </ScrollableOverlay>
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
                ? t('session.githubIntegration.selected.issueNumber', { number: selectedIssue.number })
                : t('session.githubIntegration.selected.prNumber', { number: selectedPr?.item.number ?? '' })}
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
          footer={!isConnected ? undefined : footerContent}
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
                    { id: 'issues', label: t('session.githubIntegration.tabs.issues'), icon: <Icon name="git-branch" className="h-3.5 w-3.5" /> },
                    { id: 'prs', label: t('session.githubIntegration.tabs.pullRequests'), icon: <Icon name="git-pull-request" className="h-3.5 w-3.5" /> },
                  ]}
                  activeId={activeTab}
                  onSelect={handleTabSelect}
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
                      ? t('session.githubIntegration.selected.issueNumber', { number: selectedIssue.number })
                      : t('session.githubIntegration.selected.prNumber', { number: selectedPr?.item.number ?? '' })}
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
                  <Icon name="github" className="h-5 w-5" />
                  {t('session.githubIntegration.title')}
                </DialogTitle>
                
                {/* Tabs - using SortableTabsStrip */}
                <div className="w-[220px]">
                  <SortableTabsStrip
                    items={[
                      { id: 'issues', label: t('session.githubIntegration.tabs.issues'), icon: <Icon name="git-branch" className="h-3.5 w-3.5" /> },
                      { id: 'prs', label: t('session.githubIntegration.tabs.pullRequests'), icon: <Icon name="git-pull-request" className="h-3.5 w-3.5" /> },
                    ]}
                    activeId={activeTab}
                    onSelect={handleTabSelect}
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
