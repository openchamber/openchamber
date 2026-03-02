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
import { toast } from '@/components/ui';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectLabel,
  SelectGroup,
  SelectSeparator,
} from '@/components/ui/select';
import {
  RiGitBranchLine,
  RiGitRepositoryLine,
  RiGithubLine,
  RiLoader4Line,
  RiRefreshLine,
  RiErrorWarningLine,
  RiCheckLine,
  RiExternalLinkLine,
  RiCloseLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { validateWorktreeCreate, createWorktree } from '@/lib/worktrees/worktreeManager';
import { withWorktreeUpstreamDefaults } from '@/lib/worktrees/worktreeCreate';
import { getWorktreeSetupCommands } from '@/lib/openchamberConfig';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { generateBranchSlug } from '@/lib/git/branchNameGenerator';
import { useGitBranches } from '@/stores/useGitStore';
import { GitHubIntegrationDialog } from './GitHubIntegrationDialog';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import type {
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
  const isMobile = useUIStore((state) => state.isMobile);
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
  
  // Use cached branches from Git store (instant if already fetched)
  const branches = useGitBranches(projectDirectory);
  
  // Compute local and remote branch lists (same pattern as GitView)
  const localBranches = React.useMemo(() => {
    if (!branches?.all) return [];
    return branches.all
      .filter((branchName: string) => !branchName.startsWith('remotes/'))
      .sort();
  }, [branches]);
  
  const remoteBranches = React.useMemo(() => {
    if (!branches?.all) return [];
    return branches.all
      .filter((branchName: string) => branchName.startsWith('remotes/'))
      .map((branchName: string) => branchName.replace(/^remotes\//, ''))
      .sort();
  }, [branches]);
  
  // Get existing worktrees for the current project to avoid conflicts
  const availableWorktreesByProject = useSessionStore((state) => state.availableWorktreesByProject);
  const existingWorktreeNames = React.useMemo(() => {
    if (!projectDirectory) return new Set<string>();
    const worktrees = availableWorktreesByProject.get(projectDirectory) ?? [];
    return new Set(worktrees.map(wt => wt.name));
  }, [availableWorktreesByProject, projectDirectory]);
  
  // Generate a unique slug that doesn't conflict with existing worktrees
  const generateUniqueSlug = React.useCallback((maxAttempts = 10): string => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const slug = generateBranchSlug();
      if (!existingWorktreeNames.has(slug)) {
        return slug;
      }
    }
    // Fallback: add timestamp if all attempts failed
    return `${generateBranchSlug()}-${Date.now().toString(36).slice(-4)}`;
  }, [existingWorktreeNames]);
  
  const [githubDialogOpen, setGithubDialogOpen] = React.useState(false);
  
  // Mobile branch picker states
  const [existingBranchPickerOpen, setExistingBranchPickerOpen] = React.useState(false);
  const [sourceBranchPickerOpen, setSourceBranchPickerOpen] = React.useState(false);
  
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

  // Set default source branch when branches become available
  React.useEffect(() => {
    if (!branches?.all || !projectDirectory) return;
    if (newBranchState.sourceBranch) return; // Already set
    
    const loadDefaultSourceBranch = async () => {
      try {
        const rootBranch = await getRootBranch(projectDirectory).catch(() => null);
        const savedSourceBranch = localStorage.getItem(LAST_SOURCE_BRANCH_KEY);
        const defaultSourceBranch = savedSourceBranch && branches.all?.includes(savedSourceBranch)
          ? savedSourceBranch
          : rootBranch && branches.all?.includes(rootBranch)
            ? rootBranch
            : branches.all?.includes('main')
              ? 'main'
              : branches.all?.includes('master')
                ? 'master'
                : branches.all?.[0] || '';
        
        if (defaultSourceBranch) {
          setNewBranchState(prev => ({
            ...prev,
            sourceBranch: defaultSourceBranch,
          }));
        }
      } catch {
        // ignore
      }
    };
    
    void loadDefaultSourceBranch();
  }, [branches, projectDirectory, newBranchState.sourceBranch]);

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
      setValidation({
        isValidating: false,
        branchError: null,
        worktreeError: null,
        touched: false,
      });
      return;
    }
    
    // Generate unique slug when dialog opens
    const uniqueSlug = generateUniqueSlug();
    setNewBranchState(prev => ({
      ...prev,
      branchName: uniqueSlug,
      worktreeName: uniqueSlug,
      isSyncingWorktreeName: true,
    }));
  }, [open, generateUniqueSlug]);

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

  const handleClearLinkedItem = () => {
    setNewBranchState(prev => ({
      ...prev,
      linkedIssue: null,
      linkedPr: null,
      branchName: '',
      includePrDiff: false,
      isSyncingWorktreeName: true,
    }));
  };

  // Footer content
  const footerContent = (
    <div className={cn('flex gap-2', isMobile ? 'flex-col w-full' : 'flex-row items-center')}>
      {/* Validation error */}
      <div className={cn('flex items-center gap-1.5 text-destructive', isMobile ? 'w-full justify-center order-first' : 'mr-auto')}> 
        {validation.touched && (validation.branchError || validation.worktreeError) && (
          <>
            <RiErrorWarningLine className="h-3.5 w-3.5" />
            <span className="typography-micro">
              {validation.branchError && validation.worktreeError 
                ? 'Branch and Directory are required'
                : validation.branchError 
                  ? 'Branch is required' 
                  : 'Directory is required'}
            </span>
          </>
        )}
      </div>
      
      {/* Buttons */}
      <div className={cn('flex gap-2', isMobile && 'w-full')}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOpenChange(false)}
          disabled={isCreating}
          className={cn(isMobile && 'flex-1')}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleCreate}
          disabled={!canCreate || isCreating}
          className={cn('gap-1.5', isMobile && 'flex-1')}
        >
          {isCreating && <RiLoader4Line className="h-3.5 w-3.5 animate-spin" />}
          {isCreating ? 'Creating...' : 'Create Worktree'}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      {isMobile ? (
        <MobileOverlayPanel
          open={open}
          title="New Worktree"
          onClose={() => onOpenChange(false)}
          footer={footerContent}
        >
          {/* Mode Selection - using SortableTabsStrip */}
          <div className="w-full mb-4">
            <SortableTabsStrip
              items={[
                { id: 'new-branch', label: 'New Branch', icon: <RiGitBranchLine className="h-3.5 w-3.5" /> },
                { id: 'existing-branch', label: 'Existing Branch', icon: <RiGitRepositoryLine className="h-3.5 w-3.5" /> },
              ]}
              activeId={mode}
              onSelect={(id) => handleModeChange(id as Mode)}
              variant="active-pill"
              layoutMode="fit"
              className="w-full"
            />
          </div>

          <div className="space-y-6">
            {/* Branch Name / Existing Branch Selection */}
            {mode === 'existing-branch' ? (
              <div className="space-y-1.5">
                <label className="typography-ui-label text-foreground block font-semibold">
                  Select Branch
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setExistingBranchPickerOpen(true)}
                  className="w-full justify-between h-9"
                >
                  <span className={existingBranchState.selectedBranch ? 'text-foreground' : 'text-muted-foreground'}>
                    {existingBranchState.selectedBranch || 'Choose a branch...'}
                  </span>
                  <RiGitBranchLine className="h-4 w-4 text-muted-foreground" />
                </Button>
                
                {/* Mobile Branch Picker Overlay */}
                <MobileOverlayPanel
                  open={existingBranchPickerOpen}
                  title="Select Branch"
                  onClose={() => setExistingBranchPickerOpen(false)}
                >
                  <div className="space-y-4">
                    {localBranches.length === 0 && remoteBranches.length === 0 ? (
                      <div className="px-2 py-8 text-center typography-small text-muted-foreground">
                        No branches found
                      </div>
                    ) : (
                      <>
                        {localBranches.length > 0 && (
                          <div className="space-y-2">
                            <div className="typography-small font-semibold text-foreground px-2">
                              Local branches
                            </div>
                            <div className="space-y-1">
                              {localBranches.map(branch => (
                                <button
                                  key={branch}
                                  onClick={() => {
                                    setExistingBranchState(prev => ({
                                      ...prev,
                                      selectedBranch: branch,
                                      worktreeName: slugifyWorktreeName(branch),
                                    }));
                                    setValidation(prev => ({ ...prev, touched: true }));
                                    setExistingBranchPickerOpen(false);
                                  }}
                                  className={cn(
                                    'w-full text-left px-3 py-2.5 rounded-md transition-colors',
                                    existingBranchState.selectedBranch === branch
                                      ? 'bg-interactive-selection text-interactive-selection-foreground'
                                      : 'hover:bg-interactive-hover'
                                  )}
                                >
                                  <span className="typography-small break-all">{branch}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        {remoteBranches.length > 0 && (
                          <div className="space-y-2">
                            <div className="typography-small font-semibold text-foreground px-2">
                              Remote branches
                            </div>
                            <div className="space-y-1">
                              {remoteBranches.map(branch => (
                                <button
                                  key={`remotes/${branch}`}
                                  onClick={() => {
                                    setExistingBranchState(prev => ({
                                      ...prev,
                                      selectedBranch: `remotes/${branch}`,
                                      worktreeName: slugifyWorktreeName(branch),
                                    }));
                                    setValidation(prev => ({ ...prev, touched: true }));
                                    setExistingBranchPickerOpen(false);
                                  }}
                                  className={cn(
                                    'w-full text-left px-3 py-2.5 rounded-md transition-colors',
                                    existingBranchState.selectedBranch === `remotes/${branch}`
                                      ? 'bg-interactive-selection text-interactive-selection-foreground'
                                      : 'hover:bg-interactive-hover'
                                  )}
                                >
                                  <span className="typography-small break-all">{branch}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </MobileOverlayPanel>
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex flex-col items-start gap-1.5">
                  <label className="typography-ui-label text-foreground block font-semibold">
                    Branch Name
                  </label>
                  {mode === 'new-branch' && isGitHubConnected && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setGithubDialogOpen(true)}
                      className="gap-1.5 h-7"
                    >
                      <RiGithubLine className="size-4 text-status-success" />
                        {newBranchState.linkedIssue || newBranchState.linkedPr ? 'Change' : 'Start from GitHub Issue/PR'}
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
                      linkedIssue: null,
                      linkedPr: null,
                    }));
                  }}
                  onBlur={() => setValidation(prev => ({ ...prev, touched: true }))}
                  placeholder="feature/my-awesome-feature"
                  disabled={!!newBranchState.linkedPr}
                  className={cn(
                    'h-8',
                    validation.touched && validation.branchError && 'border-destructive',
                    newBranchState.linkedPr && 'bg-muted text-muted-foreground'
                  )}
                />
                {newBranchState.linkedPr && (
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <RiCheckLine className="h-3.5 w-3.5 text-status-success" />
                    <span className="typography-micro">
                      Using PR branch: {newBranchState.linkedPr.head}
                    </span>
                  </div>
                )}
                {newBranchState.linkedIssue && !newBranchState.linkedPr && (
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <RiCheckLine className="h-3.5 w-3.5 text-status-success" />
                    <span className="typography-micro">
                      From issue #{newBranchState.linkedIssue.number}: {newBranchState.linkedIssue.title}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Worktree Directory */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="typography-ui-label text-foreground font-semibold">
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
                      'flex items-center gap-1 typography-micro transition-colors px-1.5 py-0.5 rounded',
                      newBranchState.worktreeName === slugifyWorktreeName(newBranchState.branchName) || !newBranchState.branchName
                        ? 'text-muted-foreground/40 cursor-not-allowed'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                    )}
                    title="Reset to match branch name"
                  >
                    <RiRefreshLine className="h-3 w-3" />
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
                  'h-8',
                  validation.touched && validation.worktreeError && 'border-destructive'
                )}
              />
            </div>

            {/* Source Branch - Only for New Branch mode, hide when PR is selected */}
            {mode === 'new-branch' && !newBranchState.linkedPr && (
              <div className="space-y-1.5">
                <label className="typography-ui-label text-foreground block font-semibold">
                  Source Branch
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSourceBranchPickerOpen(true)}
                  className="w-full justify-between h-9"
                >
                  <span className={newBranchState.sourceBranch ? 'text-foreground' : 'text-muted-foreground'}>
                    {newBranchState.sourceBranch || 'Select source branch...'}
                  </span>
                  <RiGitBranchLine className="h-4 w-4 text-muted-foreground" />
                </Button>
                {newBranchState.sourceBranch && (
                  <div className="typography-micro text-muted-foreground">
                    New branch will be created from {newBranchState.sourceBranch}
                  </div>
                )}
                
                {/* Mobile Source Branch Picker Overlay */}
                <MobileOverlayPanel
                  open={sourceBranchPickerOpen}
                  title="Select Source Branch"
                  onClose={() => setSourceBranchPickerOpen(false)}
                >
                  <div className="space-y-4">
                    {localBranches.length === 0 && remoteBranches.length === 0 ? (
                      <div className="px-2 py-8 text-center typography-small text-muted-foreground">
                        No branches found
                      </div>
                    ) : (
                      <>
                        {localBranches.length > 0 && (
                          <div className="space-y-2">
                            <div className="typography-small font-semibold text-foreground px-2">
                              Local branches
                            </div>
                            <div className="space-y-1">
                              {localBranches.map(branch => (
                                <button
                                  key={branch}
                                  onClick={() => {
                                    setNewBranchState(prev => ({ ...prev, sourceBranch: branch }));
                                    setSourceBranchPickerOpen(false);
                                  }}
                                  className={cn(
                                    'w-full text-left px-3 py-2.5 rounded-md transition-colors',
                                    newBranchState.sourceBranch === branch
                                      ? 'bg-interactive-selection text-interactive-selection-foreground'
                                      : 'hover:bg-interactive-hover'
                                  )}
                                >
                                  <span className="typography-small break-all">{branch}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        {remoteBranches.length > 0 && (
                          <div className="space-y-2">
                            <div className="typography-small font-semibold text-foreground px-2">
                              Remote branches
                            </div>
                            <div className="space-y-1">
                              {remoteBranches.map(branch => (
                                <button
                                  key={`remotes/${branch}`}
                                  onClick={() => {
                                    setNewBranchState(prev => ({ ...prev, sourceBranch: `remotes/${branch}` }));
                                    setSourceBranchPickerOpen(false);
                                  }}
                                  className={cn(
                                    'w-full text-left px-3 py-2.5 rounded-md transition-colors',
                                    newBranchState.sourceBranch === `remotes/${branch}`
                                      ? 'bg-interactive-selection text-interactive-selection-foreground'
                                      : 'hover:bg-interactive-hover'
                                  )}
                                >
                                  <span className="typography-small break-all">{branch}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </MobileOverlayPanel>
              </div>
            )}

            {/* Linked Item Preview - Two row minimal display */}
            {(newBranchState.linkedIssue || newBranchState.linkedPr) && mode === 'new-branch' && (
              <div className="mt-2 px-2 py-1.5 rounded bg-muted/30">
                {/* Row 1: Type, number, title, actions */}
                <div className="flex items-center gap-2">
                  <RiGithubLine className="h-3.5 w-3.5 text-status-success shrink-0" />
                  
                  {newBranchState.linkedIssue && (
                    <span className="typography-micro text-muted-foreground shrink-0">
                      Issue #{newBranchState.linkedIssue.number}
                    </span>
                  )}
                  {newBranchState.linkedPr && (
                    <span className="typography-micro text-muted-foreground shrink-0">
                      PR #{newBranchState.linkedPr.number}
                    </span>
                  )}
                  
                  <span className="typography-micro text-foreground truncate flex-1">
                    {newBranchState.linkedIssue?.title || newBranchState.linkedPr?.title}
                  </span>
                  
                  <a
                    href={newBranchState.linkedIssue?.url || newBranchState.linkedPr?.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <RiExternalLinkLine className="h-3 w-3" />
                  </a>
                  
                  <button
                    onClick={handleClearLinkedItem}
                    className="text-muted-foreground hover:text-foreground shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
                  >
                    <RiCloseLine className="h-3.5 w-3.5" />
                  </button>
                </div>
                
                {/* Row 2: PR branch info + diff indicator */}
                {newBranchState.linkedPr && (
                  <div className="flex items-center gap-2 mt-0.5 pl-5">
                    <span className="typography-micro text-muted-foreground">
                      {newBranchState.linkedPr.head} → {newBranchState.linkedPr.base}
                    </span>
                    {newBranchState.includePrDiff && (
                      <span className="typography-micro px-1 py-0.5 rounded bg-status-success/10 text-status-success">
                        +diff
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </MobileOverlayPanel>
      ) : (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
            <DialogHeader className="flex flex-row items-center justify-between">
              <div className="flex items-center gap-3">
                <DialogTitle className="flex items-center gap-2 shrink-0">
                  <RiGitBranchLine className="h-5 w-5" />
                  New Worktree
                </DialogTitle>
                
                {/* Mode Selection - using SortableTabsStrip */}
                <div className="w-[280px] shrink-0">
                  <SortableTabsStrip
                    items={[
                      { id: 'new-branch', label: 'New Branch', icon: <RiGitBranchLine className="h-3.5 w-3.5" /> },
                      { id: 'existing-branch', label: 'Existing Branch', icon: <RiGitRepositoryLine className="h-3.5 w-3.5" /> },
                    ]}
                    activeId={mode}
                    onSelect={(id) => handleModeChange(id as Mode)}
                    variant="active-pill"
                    layoutMode="fit"
                    className="w-full"
                  />
                </div>
              </div>
            </DialogHeader>

            <div className="flex-1 overflow-y-auto mt-2 space-y-6">
              {/* Branch Name / Existing Branch Selection */}
              {mode === 'existing-branch' ? (
                <div className="space-y-1.5">
                  <label className="typography-ui-label text-foreground block font-semibold">
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
                  >
                    <SelectTrigger size="lg" className="w-fit">
                      <SelectValue placeholder="Choose a branch..." />
                    </SelectTrigger>
                  <SelectContent className="max-h-[280px] max-w-[320px]">
                    {localBranches.length === 0 && remoteBranches.length === 0 ? (
                      <div className="px-2 py-4 text-center typography-small text-muted-foreground">
                        No branches found
                      </div>
                    ) : (
                      <>
                        {localBranches.length > 0 && (
                          <SelectGroup>
                            <SelectLabel className="typography-small font-semibold text-foreground">Local branches</SelectLabel>
                            {localBranches.map(branch => (
                              <SelectItem key={branch} value={branch} className="whitespace-normal break-all">
                                {branch}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        )}
                        {localBranches.length > 0 && remoteBranches.length > 0 && (
                          <SelectSeparator />
                        )}
                        {remoteBranches.length > 0 && (
                          <SelectGroup>
                            <SelectLabel className="typography-small font-semibold text-foreground">Remote branches</SelectLabel>
                            {remoteBranches.map(branch => (
                              <SelectItem key={`remotes/${branch}`} value={`remotes/${branch}`} className="whitespace-normal break-all">
                                {branch}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        )}
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="typography-ui-label text-foreground block font-semibold">
                      Branch Name
                    </label>
                    {mode === 'new-branch' && isGitHubConnected && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setGithubDialogOpen(true)}
                        className="gap-1.5 h-7"
                      >
                        <RiGithubLine className="size-4 text-status-success" />
                      {newBranchState.linkedIssue || newBranchState.linkedPr ? 'Change' : 'Start from GitHub Issue/PR'}
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
                        linkedIssue: null,
                        linkedPr: null,
                      }));
                    }}
                    onBlur={() => setValidation(prev => ({ ...prev, touched: true }))}
                    placeholder="feature/my-awesome-feature"
                    disabled={!!newBranchState.linkedPr}
                    className={cn(
                      'h-8',
                      validation.touched && validation.branchError && 'border-destructive',
                      newBranchState.linkedPr && 'bg-muted text-muted-foreground'
                    )}
                  />
                  {newBranchState.linkedPr && (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <RiCheckLine className="h-3.5 w-3.5 text-status-success" />
                      <span className="typography-micro">
                        Using PR branch: {newBranchState.linkedPr.head}
                      </span>
                    </div>
                  )}
                  {newBranchState.linkedIssue && !newBranchState.linkedPr && (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <RiCheckLine className="h-3.5 w-3.5 text-status-success" />
                      <span className="typography-micro">
                        From issue #{newBranchState.linkedIssue.number}: {newBranchState.linkedIssue.title}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Worktree Directory */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="typography-ui-label text-foreground font-semibold">
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
                        'flex items-center gap-1 typography-micro transition-colors px-1.5 py-0.5 rounded',
                        newBranchState.worktreeName === slugifyWorktreeName(newBranchState.branchName) || !newBranchState.branchName
                          ? 'text-muted-foreground/40 cursor-not-allowed'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                      )}
                      title="Reset to match branch name"
                    >
                      <RiRefreshLine className="h-3 w-3" />
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
                    'h-8',
                    validation.touched && validation.worktreeError && 'border-destructive'
                  )}
                />
              </div>

              {/* Source Branch - Only for New Branch mode, hide when PR is selected */}
              {mode === 'new-branch' && !newBranchState.linkedPr && (
                <div className="space-y-1.5">
                  <label className="typography-ui-label text-foreground block font-semibold">
                    Source Branch
                  </label>
                  <Select 
                    value={newBranchState.sourceBranch} 
                    onValueChange={(value) => setNewBranchState(prev => ({ ...prev, sourceBranch: value }))}
                  >
                    <SelectTrigger size="lg" className="w-fit">
                      <SelectValue placeholder="Select source branch..." />
                    </SelectTrigger>
                    <SelectContent className="max-h-[280px] max-w-[320px]">
                      {localBranches.length === 0 && remoteBranches.length === 0 ? (
                        <div className="px-2 py-4 text-center typography-small text-muted-foreground">
                          No branches found
                        </div>
                      ) : (
                        <>
                          {localBranches.length > 0 && (
                            <SelectGroup>
                              <SelectLabel className="typography-small font-semibold text-foreground">Local branches</SelectLabel>
                              {localBranches.map(branch => (
                                <SelectItem key={branch} value={branch} className="whitespace-normal break-all">
                                  {branch}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          )}
                          {localBranches.length > 0 && remoteBranches.length > 0 && (
                            <SelectSeparator />
                          )}
                          {remoteBranches.length > 0 && (
                            <SelectGroup>
                              <SelectLabel className="typography-small font-semibold text-foreground">Remote branches</SelectLabel>
                              {remoteBranches.map(branch => (
                                <SelectItem key={`remotes/${branch}`} value={`remotes/${branch}`} className="whitespace-normal break-all">
                                  {branch}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          )}
                        </>
                      )}
                    </SelectContent>
                  </Select>
                  {newBranchState.sourceBranch && (
                    <div className="typography-micro text-muted-foreground">
                      New branch will be created from {newBranchState.sourceBranch}
                    </div>
                  )}
                </div>
              )}

              {/* Linked Item Preview - Two row minimal display */}
              {(newBranchState.linkedIssue || newBranchState.linkedPr) && mode === 'new-branch' && (
                <div className="mt-2 px-2 py-1.5 rounded bg-muted/30">
                  {/* Row 1: Type, number, title, actions */}
                  <div className="flex items-center gap-2">
                    <RiGithubLine className="h-3.5 w-3.5 text-status-success shrink-0" />
                    
                    {newBranchState.linkedIssue && (
                      <span className="typography-micro text-muted-foreground shrink-0">
                        Issue #{newBranchState.linkedIssue.number}
                      </span>
                    )}
                    {newBranchState.linkedPr && (
                      <span className="typography-micro text-muted-foreground shrink-0">
                        PR #{newBranchState.linkedPr.number}
                      </span>
                    )}
                    
                    <span className="typography-micro text-foreground truncate flex-1">
                      {newBranchState.linkedIssue?.title || newBranchState.linkedPr?.title}
                    </span>
                    
                    <a
                      href={newBranchState.linkedIssue?.url || newBranchState.linkedPr?.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <RiExternalLinkLine className="h-3 w-3" />
                    </a>
                    
                    <button
                      onClick={handleClearLinkedItem}
                      className="text-muted-foreground hover:text-foreground shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
                    >
                      <RiCloseLine className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  
                  {/* Row 2: PR branch info + diff indicator */}
                  {newBranchState.linkedPr && (
                    <div className="flex items-center gap-2 mt-0.5 pl-5">
                      <span className="typography-micro text-muted-foreground">
                        {newBranchState.linkedPr.head} → {newBranchState.linkedPr.base}
                      </span>
                      {newBranchState.includePrDiff && (
                        <span className="typography-micro px-1 py-0.5 rounded bg-status-success/10 text-status-success">
                          +diff
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <DialogFooter className="mt-1 flex items-center justify-between">
              {/* Validation error - inline with buttons */}
              <div className="flex items-center gap-1.5 text-destructive">
                {validation.touched && (validation.branchError || validation.worktreeError) && (
                  <>
                    <RiErrorWarningLine className="h-3.5 w-3.5" />
                    <span className="typography-micro">
                      {validation.branchError && validation.worktreeError 
                        ? 'Branch and Directory are required'
                        : validation.branchError 
                          ? 'Branch is required' 
                          : 'Directory is required'}
                    </span>
                  </>
                )}
              </div>
              
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenChange(false)}
                  disabled={isCreating}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleCreate}
                  disabled={!canCreate || isCreating}
                  className="gap-1.5"
                >
                  {isCreating && <RiLoader4Line className="h-3.5 w-3.5 animate-spin" />}
                  {isCreating ? 'Creating...' : 'Create Worktree'}
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <GitHubIntegrationDialog
        open={githubDialogOpen}
        onOpenChange={setGithubDialogOpen}
        onSelect={handleGitHubSelect}
      />
    </>
  );
}
