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
import { toast } from '@/components/ui';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
  RiGitBranchLine,
  RiGitRepositoryLine,
  RiGithubLine,
  RiLoader4Line,
  RiRefreshLine,
  RiErrorWarningLine,
  RiCheckLine,
  RiExternalLinkLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { validateWorktreeCreate, createWorktree } from '@/lib/worktrees/worktreeManager';
import { withWorktreeUpstreamDefaults } from '@/lib/worktrees/worktreeCreate';
import { getWorktreeSetupCommands } from '@/lib/openchamberConfig';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { generateBranchSlug } from '@/lib/git/branchNameGenerator';
import { getGitBranches } from '@/lib/gitApi';
import { GitHubIntegrationDialog } from './GitHubIntegrationDialog';
import type {
  GitBranch,
  GitHubIssue,
  GitHubPullRequestSummary,
} from '@/lib/api/types';
import type { ProjectRef } from '@/lib/worktrees/worktreeManager';

type Mode = 'new-branch' | 'existing-branch';

interface ValidationState {
  isValidating: boolean;
  branchError: string | null;
  worktreeError: string | null;
  touched: boolean;
}

// State for New Branch mode
interface NewBranchState {
  branchName: string;
  worktreeName: string;
  isSyncingWorktreeName: boolean;
  sourceBranch: string;
  linkedIssue: GitHubIssue | null;
  linkedPr: GitHubPullRequestSummary | null;
  includePrDiff: boolean;
}

// State for Existing Branch mode
interface ExistingBranchState {
  selectedBranch: string;
  worktreeName: string;
}

const normalizeBranchName = (value: string): string => {
  return value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '');
};

const slugifyWorktreeName = (value: string): string => {
  return value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '')
    .split('/').join('-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
};

const LAST_SOURCE_BRANCH_KEY = 'oc:lastWorktreeSourceBranch';

interface NewWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onWorktreeCreated?: (worktreePath: string) => void;
}

export function NewWorktreeDialog({
  open,
  onOpenChange,
  onWorktreeCreated,
}: NewWorktreeDialogProps) {
  const githubAuthStatus = useGitHubAuthStore((state) => state.status);
  const githubAuthChecked = useGitHubAuthStore((state) => state.hasChecked);
  const activeProject = useProjectsStore((state) => state.getActiveProject());
  
  const projectDirectory = activeProject?.path ?? null;
  const projectRef: ProjectRef | null = React.useMemo(() => {
    if (projectDirectory && activeProject) {
      return { id: activeProject.id, path: projectDirectory };
    }
    return null;
  }, [activeProject, projectDirectory]);

  // Mode state
  const [mode, setMode] = React.useState<Mode>('new-branch');
  
  // Separate state for each mode (persisted when switching tabs)
  const [newBranchState, setNewBranchState] = React.useState<NewBranchState>({
    branchName: '',
    worktreeName: '',
    isSyncingWorktreeName: true,
    sourceBranch: '',
    linkedIssue: null,
    linkedPr: null,
    includePrDiff: false,
  });
  
  const [existingBranchState, setExistingBranchState] = React.useState<ExistingBranchState>({
    selectedBranch: '',
    worktreeName: '',
  });
  
  // Shared state
  const [branches, setBranches] = React.useState<GitBranch | null>(null);
  const [loadingBranches, setLoadingBranches] = React.useState(false);
  const [githubDialogOpen, setGithubDialogOpen] = React.useState(false);
  
  // Validation state
  const [validation, setValidation] = React.useState<ValidationState>({
    isValidating: false,
    branchError: null,
    worktreeError: null,
    touched: false,
  });
  
  // Creation state
  const [isCreating, setIsCreating] = React.useState(false);
  const [validationAbortController, setValidationAbortController] = React.useState<AbortController | null>(null);

  // Get current state based on mode
  const currentState = mode === 'new-branch' ? newBranchState : existingBranchState;

  // Load branches when dialog opens
  const loadBranches = React.useCallback(async () => {
    if (!projectDirectory) return;
    setLoadingBranches(true);
    try {
      const [branchData, rootBranch] = await Promise.all([
        getGitBranches(projectDirectory),
        getRootBranch(projectDirectory).catch(() => null),
      ]);
      setBranches(branchData);
      
      // Set default source branch for new-branch mode
      const savedSourceBranch = localStorage.getItem(LAST_SOURCE_BRANCH_KEY);
      const defaultSourceBranch = savedSourceBranch && branchData?.all?.includes(savedSourceBranch)
        ? savedSourceBranch
        : rootBranch && branchData?.all?.includes(rootBranch)
          ? rootBranch
          : branchData?.all?.includes('main')
            ? 'main'
            : branchData?.all?.includes('master')
              ? 'master'
              : branchData?.all?.[0] || '';
      
      if (defaultSourceBranch) {
        setNewBranchState(prev => ({
          ...prev,
          sourceBranch: defaultSourceBranch,
        }));
      }
    } catch {
      // ignore
    } finally {
      setLoadingBranches(false);
    }
  }, [projectDirectory]);

  // Reset state when dialog opens/closes
  React.useEffect(() => {
    if (!open) {
      setMode('new-branch');
      setNewBranchState({
        branchName: '',
        worktreeName: '',
        isSyncingWorktreeName: true,
        sourceBranch: '',
        linkedIssue: null,
        linkedPr: null,
        includePrDiff: false,
      });
      setExistingBranchState({
        selectedBranch: '',
        worktreeName: '',
      });
      setBranches(null);
      setValidation({
        isValidating: false,
        branchError: null,
        worktreeError: null,
        touched: false,
      });
      return;
    }
    
    void loadBranches();
  }, [open, loadBranches]);

  // Sync worktree name with branch name for new-branch mode
  React.useEffect(() => {
    if (mode !== 'new-branch' || !newBranchState.isSyncingWorktreeName) return;
    
    const normalizedBranch = normalizeBranchName(newBranchState.branchName);
    const newWorktreeName = slugifyWorktreeName(normalizedBranch);
    setNewBranchState(prev => ({ ...prev, worktreeName: newWorktreeName }));
  }, [mode, newBranchState.branchName, newBranchState.isSyncingWorktreeName]);

  // Validation - only runs after fields are touched
  const validateInputs = React.useCallback(async () => {
    if (!projectRef || !validation.touched) return;
    
    // Cancel previous validation
    if (validationAbortController) {
      validationAbortController.abort();
    }
    
    const abortController = new AbortController();
    setValidationAbortController(abortController);
    
    setValidation(prev => ({ ...prev, isValidating: true }));
    
    try {
      const branchName = mode === 'new-branch' ? newBranchState.branchName : existingBranchState.selectedBranch;
      const worktreeName = currentState.worktreeName;
      const normalizedBranch = normalizeBranchName(branchName);
      const normalizedWorktree = slugifyWorktreeName(worktreeName);
      
      let branchError: string | null = null;
      let worktreeError: string | null = null;
      
      if (!normalizedBranch && mode !== 'existing-branch') {
        branchError = 'Branch name is required';
      }
      
      if (!normalizedWorktree) {
        worktreeError = 'Worktree directory is required';
      }
      
      // Only run server validation if we have values
      if ((normalizedBranch || mode === 'existing-branch') && normalizedWorktree) {
        const result = await validateWorktreeCreate(projectRef, {
          mode: mode === 'existing-branch' ? 'existing' : 'new',
          branchName: normalizedBranch,
          worktreeName: normalizedWorktree,
          existingBranch: mode === 'existing-branch' ? normalizedBranch : undefined,
        });
        
        if (abortController.signal.aborted) return;
        
        if (!result.ok) {
          result.errors.forEach(error => {
            if (error.code === 'branch_in_use' || error.code === 'branch_exists') {
              branchError = error.message;
            } else if (error.code === 'worktree_exists') {
              worktreeError = error.message;
            }
          });
        }
      }
      
      if (!abortController.signal.aborted) {
        setValidation(prev => ({
          ...prev,
          isValidating: false,
          branchError,
          worktreeError,
        }));
      }
    } catch {
      if (!abortController.signal.aborted) {
        setValidation(prev => ({
          ...prev,
          isValidating: false,
        }));
      }
    }
  }, [projectRef, mode, newBranchState.branchName, existingBranchState.selectedBranch, currentState.worktreeName, validation.touched, validationAbortController]);

  // Extract branch name for dependency array
  const currentBranchName = mode === 'new-branch' ? newBranchState.branchName : existingBranchState.selectedBranch;

  // Trigger validation on input changes (only after touched)
  React.useEffect(() => {
    if (!open || !projectRef || !validation.touched) return;
    
    const timer = setTimeout(() => {
      void validateInputs();
    }, 300);
    
    return () => clearTimeout(timer);
  }, [currentState.worktreeName, currentBranchName, open, projectRef, validateInputs, validation.touched]);

  // Handle worktree creation
  const handleCreate = async () => {
    if (!projectRef || !projectDirectory) {
      toast.error('No active project');
      return;
    }
    
    // Mark as touched and validate immediately
    setValidation(prev => ({ ...prev, touched: true }));
    
    const branchName = mode === 'new-branch' ? newBranchState.branchName : existingBranchState.selectedBranch;
    const worktreeName = currentState.worktreeName;
    const normalizedBranch = normalizeBranchName(branchName);
    const normalizedWorktree = slugifyWorktreeName(worktreeName);
    
    if (!normalizedBranch && mode !== 'existing-branch') {
      toast.error('Branch name is required');
      return;
    }
    
    if (!normalizedWorktree) {
      toast.error('Worktree directory is required');
      return;
    }
    
    setIsCreating(true);
    
    try {
      const setupCommands = await getWorktreeSetupCommands(projectRef);
      
      // Determine source branch - use PR base if PR is selected, otherwise use selected source branch
      const effectiveSourceBranch = newBranchState.linkedPr 
        ? newBranchState.linkedPr.base 
        : newBranchState.sourceBranch;
      
      const args = {
        preferredName: normalizedBranch || normalizedWorktree,
        mode: mode === 'existing-branch' ? 'existing' as const : 'new' as const,
        branchName: mode === 'existing-branch' ? undefined : normalizedBranch,
        worktreeName: normalizedWorktree,
        existingBranch: mode === 'existing-branch' ? normalizedBranch : undefined,
        setupCommands,
        ...(effectiveSourceBranch && mode === 'new-branch' ? { startRef: effectiveSourceBranch } : {}),
      };
      
      const resolvedArgs = await withWorktreeUpstreamDefaults(projectDirectory, args);
      const metadata = await createWorktree(projectRef, resolvedArgs);
      
      // Save source branch preference (only if not from PR)
      if (newBranchState.sourceBranch && mode === 'new-branch' && !newBranchState.linkedPr) {
        localStorage.setItem(LAST_SOURCE_BRANCH_KEY, newBranchState.sourceBranch);
      }
      
      toast.success('Worktree created', {
        description: `${metadata.branch || metadata.name}${effectiveSourceBranch ? ` from ${effectiveSourceBranch}` : ''}`,
      });
      
      onOpenChange(false);
      onWorktreeCreated?.(metadata.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create worktree';
      toast.error('Failed to create worktree', { description: message });
    } finally {
      setIsCreating(false);
    }
  };

  // Handle mode change
  const handleModeChange = (newMode: Mode) => {
    setMode(newMode);
    setValidation(prev => ({ ...prev, touched: false, branchError: null, worktreeError: null }));
  };

  // Handle GitHub selection
  const handleGitHubSelect = (result: {
    type: 'issue' | 'pr';
    item: GitHubIssue | GitHubPullRequestSummary;
    includeDiff?: boolean;
  } | null) => {
    if (!result) {
      setNewBranchState(prev => ({
        ...prev,
        linkedIssue: null,
        linkedPr: null,
        includePrDiff: false,
        branchName: '',
      }));
      return;
    }

    if (result.type === 'issue') {
      const issue = result.item as GitHubIssue;
      const newBranchName = `issue-${issue.number}-${generateBranchSlug()}`;
      setNewBranchState(prev => ({
        ...prev,
        linkedIssue: issue,
        linkedPr: null,
        includePrDiff: false,
        branchName: newBranchName,
        worktreeName: slugifyWorktreeName(newBranchName),
        isSyncingWorktreeName: true,
      }));
    } else if (result.type === 'pr') {
      const pr = result.item as GitHubPullRequestSummary;
      setNewBranchState(prev => ({
        ...prev,
        linkedPr: pr,
        linkedIssue: null,
        includePrDiff: result.includeDiff ?? false,
        branchName: pr.head,
        worktreeName: slugifyWorktreeName(pr.head),
        isSyncingWorktreeName: true,
      }));
    }
  };

  // GitHub connection check
  const isGitHubConnected = githubAuthChecked && githubAuthStatus?.connected === true;

  // Check if form is valid for submission
  const isFormValid = mode === 'existing-branch'
    ? !!existingBranchState.selectedBranch && !!existingBranchState.worktreeName && !validation.branchError && !validation.worktreeError
    : !!normalizeBranchName(newBranchState.branchName) && !!newBranchState.worktreeName && !validation.branchError && !validation.worktreeError;

  const canCreate = isFormValid && !isCreating;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0">
          <DialogHeader className="flex-shrink-0 px-6 pt-6 pb-4 border-b border-border/50">
            <DialogTitle className="flex items-center gap-2 typography-ui-header font-semibold">
              <RiGitBranchLine className="h-5 w-5" />
              New Worktree
            </DialogTitle>
            <DialogDescription className="typography-small text-muted-foreground">
              Create a new worktree with customizable options
            </DialogDescription>
          </DialogHeader>

          <ScrollableOverlay className="flex-1 px-6 py-4">
            <div className="space-y-5">
              {/* Mode Selection */}
              <div className="flex items-center gap-2 p-1 bg-muted rounded-lg w-fit">
                <button
                  onClick={() => handleModeChange('new-branch')}
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5 rounded-md typography-ui-label transition-all',
                    mode === 'new-branch'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted-foreground/5'
                  )}
                >
                  <RiGitBranchLine className="h-4 w-4" />
                  New Branch
                </button>
                <button
                  onClick={() => handleModeChange('existing-branch')}
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5 rounded-md typography-ui-label transition-all',
                    mode === 'existing-branch'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted-foreground/5'
                  )}
                >
                  <RiGitRepositoryLine className="h-4 w-4" />
                  Existing Branch
                </button>
              </div>

              {/* Branch Name / Existing Branch Selection */}
              {mode === 'existing-branch' ? (
                <div className="space-y-2">
                  <label className="typography-ui-label text-foreground font-medium block">
                    Select Branch
                  </label>
                  <Select
                    value={existingBranchState.selectedBranch}
                    onValueChange={(value) => {
                      setExistingBranchState(prev => ({
                        ...prev,
                        selectedBranch: value,
                        worktreeName: slugifyWorktreeName(value),
                      }));
                      setValidation(prev => ({ ...prev, touched: true }));
                    }}
                    disabled={loadingBranches}
                  >
                    <SelectTrigger className="w-full h-9">
                      <SelectValue placeholder="Choose a branch..." />
                    </SelectTrigger>
                    <SelectContent>
                      {loadingBranches ? (
                        <div className="flex items-center justify-center py-4">
                          <RiLoader4Line className="h-4 w-4 animate-spin text-muted-foreground" />
                        </div>
                      ) : branches?.all && branches.all.length > 0 ? (
                        branches.all.map(branch => (
                          <SelectItem key={branch} value={branch}>
                            {branch}
                          </SelectItem>
                        ))
                      ) : (
                        <div className="px-2 py-4 text-center typography-small text-muted-foreground">
                          No branches found
                        </div>
                      )}
                    </SelectContent>
                  </Select>
                  {validation.touched && validation.branchError && (
                    <div className="flex items-center gap-1.5 text-destructive">
                      <RiErrorWarningLine className="h-3.5 w-3.5" />
                      <span className="typography-small">{validation.branchError}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="typography-ui-label text-foreground font-medium block">
                      Branch Name
                    </label>
                    {mode === 'new-branch' && isGitHubConnected && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setGithubDialogOpen(true)}
                        className="h-7 gap-1.5"
                      >
                        <RiGithubLine className="h-3.5 w-3.5" />
                        {newBranchState.linkedIssue || newBranchState.linkedPr ? 'Change' : 'Select from GitHub'}
                      </Button>
                    )}
                  </div>
                  <Input
                    value={newBranchState.branchName}
                    onChange={(e) => {
                      setNewBranchState(prev => ({
                        ...prev,
                        branchName: e.target.value,
                        isSyncingWorktreeName: true,
                        // Clear GitHub selection when manually typing
                        linkedIssue: null,
                        linkedPr: null,
                      }));
                    }}
                    onBlur={() => setValidation(prev => ({ ...prev, touched: true }))}
                    placeholder="feature/my-awesome-feature"
                    disabled={!!newBranchState.linkedPr}
                    className={cn(
                      'h-9',
                      validation.touched && validation.branchError && 'border-destructive',
                      newBranchState.linkedPr && 'bg-muted text-muted-foreground'
                    )}
                  />
                  {newBranchState.linkedPr && (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <RiCheckLine className="h-3.5 w-3.5 text-status-success" />
                      <span className="typography-small">
                        Using PR branch: {newBranchState.linkedPr.head}
                      </span>
                    </div>
                  )}
                  {newBranchState.linkedIssue && !newBranchState.linkedPr && (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <RiCheckLine className="h-3.5 w-3.5 text-status-success" />
                      <span className="typography-small">
                        From issue #{newBranchState.linkedIssue.number}: {newBranchState.linkedIssue.title}
                      </span>
                    </div>
                  )}
                  {validation.touched && validation.branchError && (
                    <div className="flex items-center gap-1.5 text-destructive">
                      <RiErrorWarningLine className="h-3.5 w-3.5" />
                      <span className="typography-small">{validation.branchError}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Worktree Directory */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="typography-ui-label text-foreground font-medium">
                    Worktree Directory
                  </label>
                  {mode !== 'existing-branch' && (
                    <button
                      onClick={() => {
                        const syncedName = slugifyWorktreeName(mode === 'new-branch' ? newBranchState.branchName : '');
                        setNewBranchState(prev => ({
                          ...prev,
                          worktreeName: syncedName,
                          isSyncingWorktreeName: true,
                        }));
                      }}
                      disabled={!newBranchState.branchName || newBranchState.worktreeName === slugifyWorktreeName(newBranchState.branchName)}
                      className={cn(
                        'flex items-center gap-1.5 typography-meta transition-colors px-2 py-1 rounded',
                        newBranchState.worktreeName === slugifyWorktreeName(newBranchState.branchName) || !newBranchState.branchName
                          ? 'text-muted-foreground/50 cursor-not-allowed'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                      )}
                      title="Reset to match branch name"
                    >
                      <RiRefreshLine className="h-3.5 w-3.5" />
                      <span>Reset</span>
                    </button>
                  )}
                </div>
                <Input
                  value={currentState.worktreeName}
                  onChange={(e) => {
                    if (mode === 'new-branch') {
                      setNewBranchState(prev => ({
                        ...prev,
                        worktreeName: e.target.value,
                        isSyncingWorktreeName: false,
                      }));
                    } else {
                      setExistingBranchState(prev => ({
                        ...prev,
                        worktreeName: e.target.value,
                      }));
                    }
                  }}
                  onBlur={() => setValidation(prev => ({ ...prev, touched: true }))}
                  placeholder="my-worktree-directory"
                  className={cn(
                    'h-9',
                    validation.touched && validation.worktreeError && 'border-destructive'
                  )}
                />
                {validation.touched && validation.worktreeError && (
                  <div className="flex items-center gap-1.5 text-destructive">
                    <RiErrorWarningLine className="h-3.5 w-3.5" />
                    <span className="typography-small">{validation.worktreeError}</span>
                  </div>
                )}
              </div>

              {/* Source Branch - Only for New Branch mode, hide when PR is selected */}
              {mode === 'new-branch' && !newBranchState.linkedPr && (
                <div className="space-y-2">
                  <label className="typography-ui-label text-foreground font-medium block">
                    Source Branch
                  </label>
                  <Select 
                    value={newBranchState.sourceBranch} 
                    onValueChange={(value) => setNewBranchState(prev => ({ ...prev, sourceBranch: value }))}
                  >
                    <SelectTrigger className="w-full h-9">
                      <SelectValue placeholder="Select source branch..." />
                    </SelectTrigger>
                    <SelectContent>
                      {branches?.all && branches.all.length > 0 ? (
                        branches.all.map(branch => (
                          <SelectItem key={branch} value={branch}>
                            {branch}
                          </SelectItem>
                        ))
                      ) : (
                        <div className="px-2 py-4 text-center typography-small text-muted-foreground">
                          No branches found
                        </div>
                      )}
                    </SelectContent>
                  </Select>
                  {newBranchState.sourceBranch && (
                    <div className="typography-small text-muted-foreground">
                      New branch will be created from {newBranchState.sourceBranch}
                    </div>
                  )}
                </div>
              )}

              {/* Linked Item Details */}
              {(newBranchState.linkedIssue || newBranchState.linkedPr) && mode === 'new-branch' && (
                <div className="space-y-3 pt-2 border-t border-border/50">
                  <label className="typography-ui-label text-foreground font-medium">
                    Linked to GitHub
                  </label>
                  
                  {newBranchState.linkedIssue && (
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50 border border-border/50">
                      <RiGithubLine className="h-4 w-4 text-status-success shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="typography-small font-medium">
                            Issue #{newBranchState.linkedIssue.number}
                          </span>
                          <a
                            href={newBranchState.linkedIssue.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <RiExternalLinkLine className="h-3 w-3" />
                          </a>
                        </div>
                        <p className="typography-small text-muted-foreground line-clamp-1">
                          {newBranchState.linkedIssue.title}
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          setNewBranchState(prev => ({
                            ...prev,
                            linkedIssue: null,
                            branchName: '',
                            isSyncingWorktreeName: true,
                          }));
                        }}
                        className="text-muted-foreground hover:text-foreground shrink-0"
                      >
                        <span className="sr-only">Remove</span>
                        ×
                      </button>
                    </div>
                  )}
                  
                  {newBranchState.linkedPr && (
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50 border border-border/50">
                      <RiGithubLine className="h-4 w-4 text-status-success shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="typography-small font-medium">
                            PR #{newBranchState.linkedPr.number}
                          </span>
                          <span className="typography-micro text-muted-foreground">
                            {newBranchState.linkedPr.head} → {newBranchState.linkedPr.base}
                          </span>
                          <a
                            href={newBranchState.linkedPr.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <RiExternalLinkLine className="h-3 w-3" />
                          </a>
                        </div>
                        <p className="typography-small text-muted-foreground line-clamp-1">
                          {newBranchState.linkedPr.title}
                        </p>
                        {newBranchState.includePrDiff && (
                          <p className="typography-micro text-muted-foreground mt-1">
                            PR diff will be included in session context
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => {
                          setNewBranchState(prev => ({
                            ...prev,
                            linkedPr: null,
                            branchName: '',
                            includePrDiff: false,
                            isSyncingWorktreeName: true,
                          }));
                        }}
                        className="text-muted-foreground hover:text-foreground shrink-0"
                      >
                        <span className="sr-only">Remove</span>
                        ×
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </ScrollableOverlay>

          {/* Footer */}
          <DialogFooter className="flex-shrink-0 px-6 py-4 border-t border-border/50">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isCreating}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!canCreate || isCreating}
              className="gap-2"
            >
              {isCreating && <RiLoader4Line className="h-4 w-4 animate-spin" />}
              {isCreating ? 'Creating...' : 'Create Worktree'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <GitHubIntegrationDialog
        open={githubDialogOpen}
        onOpenChange={setGithubDialogOpen}
        onSelect={handleGitHubSelect}
      />
    </>
  );
}
