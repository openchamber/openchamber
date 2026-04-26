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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
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
  RiArrowDownSLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import * as sessionActions from '@/sync/session-actions';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextStore } from '@/stores/contextStore';
import { validateWorktreeCreate, createWorktree } from '@/lib/worktrees/worktreeManager';
import { withWorktreeUpstreamDefaults } from '@/lib/worktrees/worktreeCreate';
import { getWorktreeSetupCommands } from '@/lib/openchamberConfig';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { generateBranchSlug } from '@/lib/git/branchNameGenerator';
import { opencodeClient } from '@/lib/opencode/client';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { rankBranchesForQuery } from '@/lib/worktrees/branchSearch';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useGitBranches, useGitStore, useGitLoadingBranches } from '@/stores/useGitStore';
import { GitHubIntegrationDialog } from './GitHubIntegrationDialog';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import type {
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssuesListResult,
  GitHubPullRequestContextResult,
  GitHubPullRequestSummary,
} from '@/lib/api/types';
import type { ProjectRef } from '@/lib/worktrees/worktreeManager';
import { useI18n } from '@/lib/i18n';

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

const sanitizeRemoteName = (value: string): string => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'pr-head';
};

const resolvePrWorktreeConfig = (pr: GitHubPullRequestSummary, remoteBranches: string[]) => {
  const headBranch = normalizeBranchName(pr.head || '');
  if (!headBranch) {
    throw new Error('PR head branch is missing');
  }

  const availableRemoteBranch = remoteBranches.find((remoteBranch) => {
    const slashIndex = remoteBranch.indexOf('/');
    if (slashIndex <= 0 || slashIndex >= remoteBranch.length - 1) {
      return false;
    }
    return remoteBranch.slice(slashIndex + 1) === headBranch;
  });

  if (availableRemoteBranch) {
    const slashIndex = availableRemoteBranch.indexOf('/');
    const remoteName = availableRemoteBranch.slice(0, slashIndex);
    return {
      existingBranch: `remotes/${availableRemoteBranch}`,
      setUpstream: true as const,
      upstreamRemote: remoteName,
      upstreamBranch: headBranch,
      ensureRemoteName: undefined,
      ensureRemoteUrl: undefined,
      sourceLabel: `${remoteName}/${headBranch}`,
    };
  }

  const ownerFromLabel = String(pr.headLabel || '').split(':')[0]?.trim();
  const remoteSeed = pr.headRepo?.owner || ownerFromLabel || 'pr-head';
  const remoteName = `pr-${sanitizeRemoteName(remoteSeed)}`;
  const remoteUrl = pr.headRepo?.sshUrl || pr.headRepo?.cloneUrl || '';

  if (!remoteUrl) {
    throw new Error('PR head repository URL is unavailable');
  }

  return {
    existingBranch: `remotes/${remoteName}/${headBranch}`,
    setUpstream: true as const,
    upstreamRemote: remoteName,
    upstreamBranch: headBranch,
    ensureRemoteName: remoteName,
    ensureRemoteUrl: remoteUrl,
    sourceLabel: `${remoteName}/${headBranch}`,
  };
};

interface NewWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onWorktreeCreated?: (worktreePath: string, options?: { sessionId?: string }) => void;
}

const buildIssueContextText = (args: {
  repo: GitHubIssuesListResult['repo'] | undefined;
  issue: GitHubIssue;
  comments: GitHubIssueComment[];
}) => {
  const payload = {
    repo: args.repo ?? null,
    issue: args.issue,
    comments: args.comments,
  };
  return `GitHub issue context (JSON)\n${JSON.stringify(payload, null, 2)}`;
};

const buildPullRequestContextText = (payload: GitHubPullRequestContextResult) => {
  return `GitHub pull request context (JSON)\n${JSON.stringify(payload, null, 2)}`;
};

export function NewWorktreeDialog({
  open,
  onOpenChange,
  onWorktreeCreated,
}: NewWorktreeDialogProps) {
  const { t } = useI18n();
  const { github, git } = useRuntimeAPIs();
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
  const isLoadingBranches = useGitLoadingBranches(projectDirectory);
  const fetchBranches = useGitStore((state) => state.fetchBranches);

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
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
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
  
  // Desktop branch picker states
  const [existingBranchDropdownOpen, setExistingBranchDropdownOpen] = React.useState(false);
  const [sourceBranchDropdownOpen, setSourceBranchDropdownOpen] = React.useState(false);

  // Mobile branch picker states
  const [existingBranchPickerOpen, setExistingBranchPickerOpen] = React.useState(false);
  const [sourceBranchPickerOpen, setSourceBranchPickerOpen] = React.useState(false);

  // Shared query state per picker (desktop + mobile)
  const [existingBranchQuery, setExistingBranchQuery] = React.useState('');
  const [sourceBranchQuery, setSourceBranchQuery] = React.useState('');
  const existingBranchDropdownContentRef = React.useRef<HTMLDivElement | null>(null);
  const sourceBranchDropdownContentRef = React.useRef<HTMLDivElement | null>(null);
  const existingBranchMobileListWrapperRef = React.useRef<HTMLDivElement | null>(null);
  const sourceBranchMobileListWrapperRef = React.useRef<HTMLDivElement | null>(null);

  const findScrollableContainer = React.useCallback((startNode: HTMLElement | null): HTMLElement | null => {
    let node: HTMLElement | null = startNode;
    while (node && node !== document.body) {
      const { overflowY } = window.getComputedStyle(node);
      if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }, []);

  const resetScrollToTop = React.useCallback((container: HTMLElement | null) => {
    if (!container) {
      return;
    }
    container.scrollTop = 0;
  }, []);

  const resetDesktopPickerScroll = React.useCallback((contentRef: React.RefObject<HTMLDivElement | null>) => {
    const list = contentRef.current?.querySelector<HTMLElement>('[data-slot="command-list"]') ?? null;
    resetScrollToTop(list);
  }, [resetScrollToTop]);

  const resetMobilePickerScroll = React.useCallback((wrapperRef: React.RefObject<HTMLDivElement | null>) => {
    const scrollContainer = findScrollableContainer(wrapperRef.current);
    resetScrollToTop(scrollContainer);
  }, [findScrollableContainer, resetScrollToTop]);

  const existingBranchRankedGroups = React.useMemo(() => {
    return rankBranchesForQuery({
      localBranches,
      remoteBranches,
      query: existingBranchQuery,
    });
  }, [localBranches, remoteBranches, existingBranchQuery]);

  const sourceBranchRankedGroups = React.useMemo(() => {
    return rankBranchesForQuery({
      localBranches,
      remoteBranches,
      query: sourceBranchQuery,
    });
  }, [localBranches, remoteBranches, sourceBranchQuery]);

  const hasExistingBranchQuery = existingBranchQuery.trim().length > 0;
  const hasSourceBranchQuery = sourceBranchQuery.trim().length > 0;
  const hasExistingBranchMatches = existingBranchRankedGroups.matching.length > 0;
  const hasSourceBranchMatches = sourceBranchRankedGroups.matching.length > 0;
  const canFetchBranches = Boolean(projectDirectory && git);

  const handleFetchBranches = React.useCallback(() => {
    if (!projectDirectory || !git) {
      return;
    }
    void fetchBranches(projectDirectory, git);
  }, [projectDirectory, git, fetchBranches]);

  React.useEffect(() => {
    if (!existingBranchDropdownOpen && !existingBranchPickerOpen) {
      setExistingBranchQuery('');
    }
  }, [existingBranchDropdownOpen, existingBranchPickerOpen]);

  React.useEffect(() => {
    if (!sourceBranchDropdownOpen && !sourceBranchPickerOpen) {
      setSourceBranchQuery('');
    }
  }, [sourceBranchDropdownOpen, sourceBranchPickerOpen]);

  React.useEffect(() => {
    if (existingBranchDropdownOpen) {
      resetDesktopPickerScroll(existingBranchDropdownContentRef);
    }
    if (existingBranchPickerOpen) {
      resetMobilePickerScroll(existingBranchMobileListWrapperRef);
    }
  }, [
    existingBranchDropdownOpen,
    existingBranchPickerOpen,
    existingBranchQuery,
    resetDesktopPickerScroll,
    resetMobilePickerScroll,
  ]);

  React.useEffect(() => {
    if (sourceBranchDropdownOpen) {
      resetDesktopPickerScroll(sourceBranchDropdownContentRef);
    }
    if (sourceBranchPickerOpen) {
      resetMobilePickerScroll(sourceBranchMobileListWrapperRef);
    }
  }, [
    sourceBranchDropdownOpen,
    sourceBranchPickerOpen,
    sourceBranchQuery,
    resetDesktopPickerScroll,
    resetMobilePickerScroll,
  ]);

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

  const resolveDefaultAgentName = React.useCallback((): string | undefined => {
    const configState = useConfigStore.getState();
    const visibleAgents = configState.getVisibleAgents();

    if (configState.settingsDefaultAgent) {
      const settingsAgent = visibleAgents.find((a) => a.name === configState.settingsDefaultAgent);
      if (settingsAgent) {
        return settingsAgent.name;
      }
    }

    return visibleAgents.find((agent) => agent.name === 'build')?.name || visibleAgents[0]?.name;
  }, []);

  const resolveDefaultModelSelection = React.useCallback((): { providerID: string; modelID: string } | null => {
    const configState = useConfigStore.getState();
    const settingsDefaultModel = configState.settingsDefaultModel;
    if (!settingsDefaultModel) return null;

    const parts = settingsDefaultModel.split('/');
    if (parts.length !== 2) return null;
    const [providerID, modelID] = parts;
    if (!providerID || !modelID) return null;

    const modelMetadata = configState.getModelMetadata(providerID, modelID);
    if (!modelMetadata) return null;
    return { providerID, modelID };
  }, []);

  const resolveDefaultVariant = React.useCallback((providerID: string, modelID: string): string | undefined => {
    const configState = useConfigStore.getState();
    const settingsDefaultVariant = configState.settingsDefaultVariant;
    if (!settingsDefaultVariant) return undefined;

    const provider = configState.providers.find((p) => p.id === providerID);
    const model = provider?.models.find((m: Record<string, unknown>) => (m as { id?: string }).id === modelID) as
      | { variants?: Record<string, unknown> }
      | undefined;
    const variants = model?.variants;
    if (!variants) return undefined;
    if (!Object.prototype.hasOwnProperty.call(variants, settingsDefaultVariant)) return undefined;
    return settingsDefaultVariant;
  }, []);

  const applySessionModelAndAgentDefaults = React.useCallback((args: {
    sessionId: string;
    providerID: string;
    modelID: string;
    agentName?: string;
    variant?: string;
  }) => {
    const configState = useConfigStore.getState();

    try {
      useContextStore.getState().saveSessionModelSelection(args.sessionId, args.providerID, args.modelID);
    } catch {
      // ignore
    }

    if (!args.agentName) {
      return;
    }

    try {
      configState.setAgent(args.agentName);
    } catch {
      // ignore
    }
    try {
      useContextStore.getState().saveSessionAgentSelection(args.sessionId, args.agentName);
    } catch {
      // ignore
    }
    try {
      useContextStore.getState().saveAgentModelForSession(args.sessionId, args.agentName, args.providerID, args.modelID);
    } catch {
      // ignore
    }
    if (args.variant !== undefined) {
      try {
        configState.setCurrentVariant(args.variant);
      } catch {
        // ignore
      }
      try {
        useContextStore
          .getState()
          .saveAgentModelVariantForSession(args.sessionId, args.agentName, args.providerID, args.modelID, args.variant);
      } catch {
        // ignore
      }
    }
  }, []);

  const sendLinkedContextMessage = React.useCallback(async (args: {
    sessionId: string;
    issue: GitHubIssue | null;
    pr: GitHubPullRequestSummary | null;
    includeDiff: boolean;
  }) => {
    if (!projectDirectory || !github) {
      return;
    }

    const configState = useConfigStore.getState();
    const lastUsedProvider = useSelectionStore.getState().lastUsedProvider;
    const defaultModel = resolveDefaultModelSelection();
    const providerID = defaultModel?.providerID || configState.currentProviderId || lastUsedProvider?.providerID;
    const modelID = defaultModel?.modelID || configState.currentModelId || lastUsedProvider?.modelID;
    const agentName = resolveDefaultAgentName() || configState.currentAgentName || undefined;

    if (!providerID || !modelID) {
      toast.error(t('session.newWorktree.error.noModelSelected'));
      return;
    }

    const variant = resolveDefaultVariant(providerID, modelID);

    applySessionModelAndAgentDefaults({
      sessionId: args.sessionId,
      providerID,
      modelID,
      agentName,
      variant,
    });

    if (args.issue) {
      if (!github.issueGet || !github.issueComments) {
        return;
      }

      const issueRes = await github.issueGet(projectDirectory, args.issue.number);
      if (issueRes.connected === false || !issueRes.repo || !issueRes.issue) {
        throw new Error('Failed to load issue context');
      }

      const commentsRes = await github.issueComments(projectDirectory, args.issue.number);
      if (commentsRes.connected === false) {
        throw new Error('Failed to load issue comments');
      }

      const visiblePromptText = await renderMagicPrompt('github.issue.review.visible', {
        issue_number: String(args.issue.number),
      });
      const instructionsText = await renderMagicPrompt('github.issue.review.instructions');
      const contextText = buildIssueContextText({
        repo: issueRes.repo,
        issue: issueRes.issue,
        comments: commentsRes.comments ?? [],
      });

      await opencodeClient.sendMessage({
        id: args.sessionId,
        providerID,
        modelID,
        agent: agentName,
        variant,
        text: visiblePromptText,
        additionalParts: [
          { text: instructionsText, synthetic: true },
          { text: contextText, synthetic: true },
        ],
      });

      toast.success(t('session.newWorktree.toast.sessionFromIssue'));
      return;
    }

    if (args.pr) {
      if (!github.prContext) {
        return;
      }

      const prContext = await github.prContext(projectDirectory, args.pr.number, {
        includeDiff: args.includeDiff,
        includeCheckDetails: false,
      });
      if (prContext.connected === false || !prContext.repo || !prContext.pr) {
        throw new Error('Failed to load PR context');
      }

      const visiblePromptText = await renderMagicPrompt('github.pr.review.visible', {
        pr_number: String(args.pr.number),
      });
      const instructionsText = await renderMagicPrompt('github.pr.review.instructions');
      const contextText = buildPullRequestContextText(prContext);

      await opencodeClient.sendMessage({
        id: args.sessionId,
        providerID,
        modelID,
        agent: agentName,
        variant,
        text: visiblePromptText,
        additionalParts: [
          { text: instructionsText, synthetic: true },
          { text: contextText, synthetic: true },
        ],
      });

      toast.success(t('session.newWorktree.toast.sessionFromPr'));
    }
  }, [
    applySessionModelAndAgentDefaults,
    github,
    projectDirectory,
    resolveDefaultAgentName,
    resolveDefaultModelSelection,
    resolveDefaultVariant,
    t,
  ]);

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
      setExistingBranchDropdownOpen(false);
      setSourceBranchDropdownOpen(false);
      setExistingBranchPickerOpen(false);
      setSourceBranchPickerOpen(false);
      setExistingBranchQuery('');
      setSourceBranchQuery('');
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
    if (!projectRef || !validation.touched || isCreating) return;
    
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
      
      if (!normalizedBranch) {
        branchError = t('session.newWorktree.error.branchNameRequired');
      }

      if (!normalizedWorktree) {
        worktreeError = t('session.newWorktree.error.worktreeDirectoryRequired');
      }
      
      // Only run server validation if we have values
      if (normalizedBranch && normalizedWorktree) {
        const result = await validateWorktreeCreate(projectRef, {
          mode: mode === 'existing-branch' ? 'existing' : 'new',
          branchName: normalizedBranch,
          worktreeName: normalizedWorktree,
          existingBranch: mode === 'existing-branch' ? normalizedBranch : undefined,
        });
        
        if (abortController.signal.aborted) return;
        
        if (!result.ok) {
          result.errors.forEach((error) => {
            if (error.code === 'worktree_exists') {
              worktreeError = worktreeError ?? error.message;
              return;
            }

            if (error.code.startsWith('branch_')) {
              branchError = branchError ?? error.message;
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
  }, [
    projectRef,
    mode,
    newBranchState.branchName,
    existingBranchState.selectedBranch,
    currentState.worktreeName,
    validation.touched,
    validationAbortController,
    isCreating,
    t,
  ]);

  // Extract branch name for dependency array
  const currentBranchName = mode === 'new-branch' ? newBranchState.branchName : existingBranchState.selectedBranch;

  // Trigger validation on input changes (only after touched)
  React.useEffect(() => {
    if (!open || !projectRef || !validation.touched || isCreating) return;
    
    const timer = setTimeout(() => {
      void validateInputs();
    }, 300);
    
    return () => clearTimeout(timer);
  }, [currentState.worktreeName, currentBranchName, open, projectRef, validateInputs, validation.touched, isCreating]);

  // Handle worktree creation
  const handleCreate = async () => {
    if (!projectRef || !projectDirectory) {
      toast.error(t('session.newWorktree.error.noActiveProject'));
      return;
    }
    
    // Mark as touched and validate immediately
    setValidation(prev => ({ ...prev, touched: true }));
    
    const branchName = mode === 'new-branch' ? newBranchState.branchName : existingBranchState.selectedBranch;
    const worktreeName = currentState.worktreeName;
    const normalizedBranch = normalizeBranchName(branchName);
    const normalizedWorktree = slugifyWorktreeName(worktreeName);
    
    if (!normalizedBranch) {
      toast.error(t('session.newWorktree.error.branchNameRequired'));
      return;
    }
    
    if (!normalizedWorktree) {
      toast.error(t('session.newWorktree.error.worktreeDirectoryRequired'));
      return;
    }

    if (validationAbortController) {
      validationAbortController.abort();
      setValidationAbortController(null);
    }

    setValidation((prev) => ({
      ...prev,
      isValidating: false,
      branchError: null,
      worktreeError: null,
    }));
    
    setIsCreating(true);
    
    try {
      const setupCommands = await getWorktreeSetupCommands(projectRef);
      const linkedPr = mode === 'new-branch' ? newBranchState.linkedPr : null;
      const sourceBranch = newBranchState.sourceBranch;

      let sourceLabel = '';
      const args = (() => {
        if (linkedPr) {
          const prConfig = resolvePrWorktreeConfig(linkedPr, remoteBranches);
          sourceLabel = prConfig.sourceLabel;
          return {
            preferredName: normalizedBranch || normalizedWorktree,
            mode: 'existing' as const,
            branchName: normalizedBranch,
            worktreeName: normalizedWorktree,
            existingBranch: prConfig.existingBranch,
            setupCommands,
            setUpstream: prConfig.setUpstream,
            upstreamRemote: prConfig.upstreamRemote,
            upstreamBranch: prConfig.upstreamBranch,
            ...(prConfig.ensureRemoteName ? { ensureRemoteName: prConfig.ensureRemoteName } : {}),
            ...(prConfig.ensureRemoteUrl ? { ensureRemoteUrl: prConfig.ensureRemoteUrl } : {}),
          };
        }

        sourceLabel = mode === 'new-branch' ? sourceBranch : '';
        return {
          preferredName: normalizedBranch || normalizedWorktree,
          mode: mode === 'existing-branch' ? 'existing' as const : 'new' as const,
          branchName: mode === 'existing-branch' ? undefined : normalizedBranch,
          worktreeName: normalizedWorktree,
          existingBranch: mode === 'existing-branch' ? normalizedBranch : undefined,
          setupCommands,
          ...(sourceBranch && mode === 'new-branch' ? { startRef: sourceBranch } : {}),
        };
      })();
      
      const resolvedArgs = await withWorktreeUpstreamDefaults(projectDirectory, args);
      const metadata = await createWorktree(projectRef, resolvedArgs);

      const linkedIssue = mode === 'new-branch' ? newBranchState.linkedIssue : null;
      const linkedPrState = mode === 'new-branch' ? newBranchState.linkedPr : null;
      const includePrDiff = mode === 'new-branch' ? newBranchState.includePrDiff : false;

      let createdSessionId: string | null = null;

      if (linkedIssue || linkedPrState) {
        const sessionTitle = linkedIssue
          ? `#${linkedIssue.number} ${linkedIssue.title}`.trim()
          : linkedPrState
            ? `#${linkedPrState.number} ${linkedPrState.title}`.trim()
            : t('session.newWorktree.newSessionTitle');

        const session = await sessionActions.createSession(sessionTitle, metadata.path, null);
        if (!session?.id) {
          throw new Error('Failed to create session');
        }

        createdSessionId = session.id;
        void sessionActions.updateSessionTitle(session.id, sessionTitle).catch(() => undefined);

        try {
          useSessionUIStore.getState().initializeNewOpenChamberSession(session.id, useConfigStore.getState().agents);
        } catch {
          // ignore
        }
      }
      
      // Save source branch preference (only if not from PR)
      if (newBranchState.sourceBranch && mode === 'new-branch' && !newBranchState.linkedPr) {
        localStorage.setItem(LAST_SOURCE_BRANCH_KEY, newBranchState.sourceBranch);
      }
      
      toast.success(t('session.newWorktree.toast.worktreeCreated'), {
        description: t('session.newWorktree.toast.worktreeCreatedDescription', {
          target: `${metadata.branch || metadata.name}${sourceLabel ? ` ${t('session.newWorktree.fromSource', { source: sourceLabel })}` : ''}`,
        }),
      });

      onOpenChange(false);

      if (createdSessionId) {
        onWorktreeCreated?.(metadata.path, { sessionId: createdSessionId });
        void sendLinkedContextMessage({
          sessionId: createdSessionId,
          issue: linkedIssue,
          pr: linkedPrState,
          includeDiff: includePrDiff,
        }).catch((error) => {
          const message = error instanceof Error ? error.message : t('session.newWorktree.error.sendGitHubContextFailed');
          toast.error(t('session.newWorktree.error.sendGitHubContextFailed'), { description: message });
        });
      } else {
        onWorktreeCreated?.(metadata.path);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t('session.newWorktree.error.createWorktreeFailed');
      toast.error(t('session.newWorktree.error.createWorktreeFailed'), { description: message });
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
              {validation.branchError || validation.worktreeError}
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
          {t('session.newWorktree.actions.cancel')}
        </Button>
        <Button
          size="sm"
          onClick={handleCreate}
          disabled={!canCreate || isCreating}
          className={cn('gap-1.5', isMobile && 'flex-1')}
        >
          {isCreating && <RiLoader4Line className="h-3.5 w-3.5 animate-spin" />}
          {isCreating ? t('session.newWorktree.actions.creating') : t('session.newWorktree.actions.createWorktree')}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      {isMobile ? (
        <MobileOverlayPanel
          open={open}
          title={t('session.newWorktree.title')}
          onClose={() => onOpenChange(false)}
          footer={footerContent}
        >
          {/* Mode Selection - using SortableTabsStrip */}
          <div className="w-full mb-4">
            <SortableTabsStrip
              items={[
                { id: 'new-branch', label: t('session.newWorktree.mode.newBranch'), icon: <RiGitBranchLine className="h-3.5 w-3.5" /> },
                { id: 'existing-branch', label: t('session.newWorktree.mode.existingBranch'), icon: <RiGitRepositoryLine className="h-3.5 w-3.5" /> },
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
                  {t('session.newWorktree.selectBranch')}
                </label>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setExistingBranchPickerOpen(true)}
                    className="flex-1 justify-between h-9"
                  >
                    <span className={existingBranchState.selectedBranch ? 'text-foreground' : 'text-muted-foreground'}>
                      {existingBranchState.selectedBranch || t('session.newWorktree.chooseBranch')}
                    </span>
                    <RiGitBranchLine className="h-4 w-4 text-muted-foreground" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 px-0 shrink-0"
                    onClick={handleFetchBranches}
                    disabled={!canFetchBranches || isLoadingBranches}
                    title={t('session.newWorktree.fetchBranches')}
                  >
                    {isLoadingBranches ? <RiLoader4Line className="size-4 animate-spin" /> : <RiRefreshLine className="size-4" />}
                  </Button>
                </div>
                
                {/* Mobile Branch Picker Overlay */}
                <MobileOverlayPanel
                  open={existingBranchPickerOpen}
                  title={t('session.newWorktree.selectBranch')}
                  onClose={() => setExistingBranchPickerOpen(false)}
                >
                  <div className="space-y-4" ref={existingBranchMobileListWrapperRef}>
                    <Input
                      value={existingBranchQuery}
                      onChange={(e) => setExistingBranchQuery(e.target.value)}
                      placeholder={t('session.newWorktree.searchBranches')}
                      className="h-8"
                    />
                    {isLoadingBranches ? (
                      <div className="px-2 py-8 text-center typography-small text-muted-foreground">
                        {t('session.newWorktree.loadingBranches')}
                      </div>
                    ) : localBranches.length === 0 && remoteBranches.length === 0 ? (
                      <div className="px-2 py-8 text-center typography-small text-muted-foreground">
                        {t('session.newWorktree.noBranchesFound')}
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {hasExistingBranchQuery && hasExistingBranchMatches && (
                          <div className="space-y-2">
                            <div className="typography-small font-semibold text-foreground px-2">
                              {t('session.newWorktree.matchingBranches')}
                            </div>
                            <div className="space-y-1">
                              {existingBranchRankedGroups.matching.map((branch) => (
                                <button
                                  key={`${branch.source}-${branch.value}`}
                                  onClick={() => {
                                    setExistingBranchState(prev => ({
                                      ...prev,
                                      selectedBranch: branch.value,
                                      worktreeName: slugifyWorktreeName(branch.label),
                                    }));
                                    setValidation(prev => ({ ...prev, touched: true }));
                                    setExistingBranchPickerOpen(false);
                                  }}
                                  className={cn(
                                    'w-full text-left px-3 py-2.5 rounded-md transition-colors',
                                    existingBranchState.selectedBranch === branch.value
                                      ? 'bg-interactive-selection text-interactive-selection-foreground'
                                      : 'hover:bg-interactive-hover'
                                  )}
                                >
                                  <span className="typography-small break-all">{branch.label}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {hasExistingBranchQuery && !hasExistingBranchMatches && (
                          <div className="px-2 py-1 text-center typography-small text-muted-foreground">
                            {t('session.newWorktree.noMatchingBranches')}
                          </div>
                        )}

                        {existingBranchRankedGroups.otherLocal.length > 0 && (
                          <div className="space-y-2">
                            <div className="typography-small font-semibold text-foreground px-2">
                              {hasExistingBranchQuery ? t('session.newWorktree.otherLocalBranches') : t('session.newWorktree.localBranches')}
                            </div>
                            <div className="space-y-1">
                              {existingBranchRankedGroups.otherLocal.map((branch) => (
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

                        {existingBranchRankedGroups.otherRemote.length > 0 && (
                          <div className="space-y-2">
                            <div className="typography-small font-semibold text-foreground px-2">
                              {hasExistingBranchQuery ? t('session.newWorktree.otherRemoteBranches') : t('session.newWorktree.remoteBranches')}
                            </div>
                            <div className="space-y-1">
                              {existingBranchRankedGroups.otherRemote.map((branch) => (
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
                      </div>
                    )}
                  </div>
                </MobileOverlayPanel>
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex flex-col items-start gap-1.5">
                  <label className="typography-ui-label text-foreground block font-semibold">
                    {t('session.newWorktree.branchName')}
                  </label>
                  {mode === 'new-branch' && isGitHubConnected && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setGithubDialogOpen(true)}
                      className="gap-1.5 h-7"
                    >
                      <RiGithubLine className="size-4 text-status-success" />
                        {newBranchState.linkedIssue || newBranchState.linkedPr ? t('session.newWorktree.actions.change') : t('session.newWorktree.actions.startFromGitHubIssuePr')}
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
                  placeholder={t('session.newWorktree.branchNamePlaceholder')}
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
                      {t('session.newWorktree.usingPrBranch', { branch: newBranchState.linkedPr.head })}
                    </span>
                  </div>
                )}
                {newBranchState.linkedIssue && !newBranchState.linkedPr && (
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <RiCheckLine className="h-3.5 w-3.5 text-status-success" />
                    <span className="typography-micro">
                      {t('session.newWorktree.fromIssue', { number: newBranchState.linkedIssue.number, title: newBranchState.linkedIssue.title })}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Worktree Directory */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="typography-ui-label text-foreground font-semibold">
                  {t('session.newWorktree.worktreeDirectory')}
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
                    title={t('session.newWorktree.resetToMatchBranchName')}
                  >
                    <RiRefreshLine className="h-3 w-3" />
                    <span>{t('session.newWorktree.actions.reset')}</span>
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
                placeholder={t('session.newWorktree.worktreeDirectoryPlaceholder')}
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
                  {t('session.newWorktree.sourceBranch')}
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSourceBranchPickerOpen(true)}
                  className="w-full justify-between h-9"
                >
                  <span className={newBranchState.sourceBranch ? 'text-foreground' : 'text-muted-foreground'}>
                    {newBranchState.sourceBranch || t('session.newWorktree.selectSourceBranchPlaceholder')}
                  </span>
                  <RiGitBranchLine className="h-4 w-4 text-muted-foreground" />
                </Button>
                {newBranchState.sourceBranch && (
                  <div className="typography-micro text-muted-foreground">
                    {t('session.newWorktree.newBranchFromSource', { source: newBranchState.sourceBranch })}
                  </div>
                )}
                
                {/* Mobile Source Branch Picker Overlay */}
                <MobileOverlayPanel
                  open={sourceBranchPickerOpen}
                  title={t('session.newWorktree.selectSourceBranch')}
                  onClose={() => setSourceBranchPickerOpen(false)}
                >
                  <div className="space-y-4" ref={sourceBranchMobileListWrapperRef}>
                    <Input
                      value={sourceBranchQuery}
                      onChange={(e) => setSourceBranchQuery(e.target.value)}
                      placeholder={t('session.newWorktree.searchBranches')}
                      className="h-8"
                    />
                    {isLoadingBranches ? (
                      <div className="px-2 py-8 text-center typography-small text-muted-foreground">
                        {t('session.newWorktree.loadingBranches')}
                      </div>
                    ) : localBranches.length === 0 && remoteBranches.length === 0 ? (
                      <div className="px-2 py-8 text-center typography-small text-muted-foreground">
                        {t('session.newWorktree.noBranchesFound')}
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {hasSourceBranchQuery && hasSourceBranchMatches && (
                          <div className="space-y-2">
                            <div className="typography-small font-semibold text-foreground px-2">
                              {t('session.newWorktree.matchingBranches')}
                            </div>
                            <div className="space-y-1">
                              {sourceBranchRankedGroups.matching.map((branch) => (
                                <button
                                  key={`${branch.source}-${branch.value}`}
                                  onClick={() => {
                                    setNewBranchState(prev => ({ ...prev, sourceBranch: branch.value }));
                                    setSourceBranchPickerOpen(false);
                                  }}
                                  className={cn(
                                    'w-full text-left px-3 py-2.5 rounded-md transition-colors',
                                    newBranchState.sourceBranch === branch.value
                                      ? 'bg-interactive-selection text-interactive-selection-foreground'
                                      : 'hover:bg-interactive-hover'
                                  )}
                                >
                                  <span className="typography-small break-all">{branch.label}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {hasSourceBranchQuery && !hasSourceBranchMatches && (
                          <div className="px-2 py-1 text-center typography-small text-muted-foreground">
                            {t('session.newWorktree.noMatchingBranches')}
                          </div>
                        )}

                        {sourceBranchRankedGroups.otherLocal.length > 0 && (
                          <div className="space-y-2">
                            <div className="typography-small font-semibold text-foreground px-2">
                              {hasSourceBranchQuery ? t('session.newWorktree.otherLocalBranches') : t('session.newWorktree.localBranches')}
                            </div>
                            <div className="space-y-1">
                              {sourceBranchRankedGroups.otherLocal.map((branch) => (
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

                        {sourceBranchRankedGroups.otherRemote.length > 0 && (
                          <div className="space-y-2">
                            <div className="typography-small font-semibold text-foreground px-2">
                              {hasSourceBranchQuery ? t('session.newWorktree.otherRemoteBranches') : t('session.newWorktree.remoteBranches')}
                            </div>
                            <div className="space-y-1">
                              {sourceBranchRankedGroups.otherRemote.map((branch) => (
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
                      </div>
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
                        {t('session.newWorktree.issueNumber', { number: newBranchState.linkedIssue.number })}
                      </span>
                    )}
                    {newBranchState.linkedPr && (
                      <span className="typography-micro text-muted-foreground shrink-0">
                        {t('session.newWorktree.prNumber', { number: newBranchState.linkedPr.number })}
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
                          {t('session.newWorktree.includeDiffBadge')}
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
                  {t('session.newWorktree.title')}
                </DialogTitle>
                
                {/* Mode Selection - using SortableTabsStrip */}
                <div className="w-[280px] shrink-0">
                  <SortableTabsStrip
                    items={[
                      { id: 'new-branch', label: t('session.newWorktree.mode.newBranch'), icon: <RiGitBranchLine className="h-3.5 w-3.5" /> },
                      { id: 'existing-branch', label: t('session.newWorktree.mode.existingBranch'), icon: <RiGitRepositoryLine className="h-3.5 w-3.5" /> },
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
                    {t('session.newWorktree.selectBranch')}
                  </label>
                  <div className="flex items-center gap-2">
                    <DropdownMenu open={existingBranchDropdownOpen} onOpenChange={setExistingBranchDropdownOpen}>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="h-9 min-w-[220px] max-w-full justify-between gap-2">
                          <span className={cn('truncate', existingBranchState.selectedBranch ? 'text-foreground' : 'text-muted-foreground')}>
                            {existingBranchState.selectedBranch || t('session.newWorktree.chooseBranch')}
                          </span>
                          <RiArrowDownSLine className="h-4 w-4 shrink-0 text-muted-foreground" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" sideOffset={6} className="w-[320px] p-0 max-h-[min(var(--available-height),24rem)] flex flex-col overflow-hidden" ref={existingBranchDropdownContentRef}>
                        <Command shouldFilter={false}>
                        <CommandInput
                          placeholder={t('session.newWorktree.searchBranches')}
                          value={existingBranchQuery}
                          onValueChange={setExistingBranchQuery}
                        />
                        <CommandList disableHorizontal>
                          {isLoadingBranches ? (
                            <div className="px-2 py-4 text-center typography-small text-muted-foreground">
                              {t('session.newWorktree.loadingBranches')}
                            </div>
                          ) : localBranches.length === 0 && remoteBranches.length === 0 ? (
                            <CommandEmpty>{t('session.newWorktree.noBranchesFound')}</CommandEmpty>
                          ) : (
                            <>
                              {hasExistingBranchQuery && hasExistingBranchMatches && (
                                <CommandGroup heading={t('session.newWorktree.matchingBranches')}>
                                  {existingBranchRankedGroups.matching.map((branch) => (
                                    <CommandItem
                                      key={`${branch.source}-${branch.value}`}
                                      value={branch.value}
                                      onSelect={() => {
                                        setExistingBranchState((prev) => ({
                                          ...prev,
                                          selectedBranch: branch.value,
                                          worktreeName: slugifyWorktreeName(branch.label),
                                        }));
                                        setValidation((prev) => ({ ...prev, touched: true }));
                                        setExistingBranchDropdownOpen(false);
                                      }}
                                    >
                                      <span className="typography-small break-all">{branch.label}</span>
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              )}

                              {hasExistingBranchQuery && !hasExistingBranchMatches && (
                                <div className="px-2 py-1 text-center typography-small text-muted-foreground">
                                  {t('session.newWorktree.noMatchingBranches')}
                                </div>
                              )}

                              {existingBranchRankedGroups.otherLocal.length > 0 && (
                                <>
                                  {hasExistingBranchQuery && <CommandSeparator />}
                                  <CommandGroup heading={hasExistingBranchQuery ? t('session.newWorktree.otherLocalBranches') : t('session.newWorktree.localBranches')}>
                                    {existingBranchRankedGroups.otherLocal.map((branch) => (
                                      <CommandItem
                                        key={`local-${branch}`}
                                        value={branch}
                                        onSelect={() => {
                                          setExistingBranchState((prev) => ({
                                            ...prev,
                                            selectedBranch: branch,
                                            worktreeName: slugifyWorktreeName(branch),
                                          }));
                                          setValidation((prev) => ({ ...prev, touched: true }));
                                          setExistingBranchDropdownOpen(false);
                                        }}
                                      >
                                        <span className="typography-small break-all">{branch}</span>
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                </>
                              )}

                              {existingBranchRankedGroups.otherRemote.length > 0 && (
                                <>
                                  {(existingBranchRankedGroups.otherLocal.length > 0 || hasExistingBranchQuery) && (
                                    <CommandSeparator />
                                  )}
                                  <CommandGroup heading={hasExistingBranchQuery ? t('session.newWorktree.otherRemoteBranches') : t('session.newWorktree.remoteBranches')}>
                                    {existingBranchRankedGroups.otherRemote.map((branch) => (
                                      <CommandItem
                                        key={`remote-${branch}`}
                                        value={`remotes/${branch}`}
                                        onSelect={() => {
                                          setExistingBranchState((prev) => ({
                                            ...prev,
                                            selectedBranch: `remotes/${branch}`,
                                            worktreeName: slugifyWorktreeName(branch),
                                          }));
                                          setValidation((prev) => ({ ...prev, touched: true }));
                                          setExistingBranchDropdownOpen(false);
                                        }}
                                      >
                                        <span className="typography-small break-all">{branch}</span>
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                </>
                              )}
                            </>
                          )}
                        </CommandList>
                        </Command>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 px-0 shrink-0"
                      onClick={handleFetchBranches}
                      disabled={!canFetchBranches || isLoadingBranches}
                      title={t('session.newWorktree.fetchBranches')}
                    >
                      {isLoadingBranches ? <RiLoader4Line className="size-4 animate-spin" /> : <RiRefreshLine className="size-4" />}
                    </Button>
                  </div>
                </div>
            ) : (
              <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="typography-ui-label text-foreground block font-semibold">
                      {t('session.newWorktree.branchName')}
                    </label>
                    {mode === 'new-branch' && isGitHubConnected && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setGithubDialogOpen(true)}
                        className="gap-1.5 h-7"
                      >
                        <RiGithubLine className="size-4 text-status-success" />
                      {newBranchState.linkedIssue || newBranchState.linkedPr ? t('session.newWorktree.actions.change') : t('session.newWorktree.actions.startFromGitHubIssuePr')}
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
                    placeholder={t('session.newWorktree.branchNamePlaceholder')}
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
                        {t('session.newWorktree.usingPrBranch', { branch: newBranchState.linkedPr.head })}
                      </span>
                    </div>
                  )}
                  {newBranchState.linkedIssue && !newBranchState.linkedPr && (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <RiCheckLine className="h-3.5 w-3.5 text-status-success" />
                      <span className="typography-micro">
                        {t('session.newWorktree.fromIssue', { number: newBranchState.linkedIssue.number, title: newBranchState.linkedIssue.title })}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Worktree Directory */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="typography-ui-label text-foreground font-semibold">
                    {t('session.newWorktree.worktreeDirectory')}
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
                      title={t('session.newWorktree.resetToMatchBranchName')}
                    >
                      <RiRefreshLine className="h-3 w-3" />
                      <span>{t('session.newWorktree.actions.reset')}</span>
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
                  placeholder={t('session.newWorktree.worktreeDirectoryPlaceholder')}
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
                  {t('session.newWorktree.sourceBranch')}
                </label>
                  <DropdownMenu open={sourceBranchDropdownOpen} onOpenChange={setSourceBranchDropdownOpen}>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="h-9 min-w-[220px] max-w-full justify-between gap-2">
                        <span className={cn('truncate', newBranchState.sourceBranch ? 'text-foreground' : 'text-muted-foreground')}>
                            {newBranchState.sourceBranch || t('session.newWorktree.selectSourceBranchPlaceholder')}
                        </span>
                        <RiArrowDownSLine className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-[320px] p-0" ref={sourceBranchDropdownContentRef}>
                      <Command shouldFilter={false}>
                        <CommandInput
                          placeholder={t('session.newWorktree.searchBranches')}
                          value={sourceBranchQuery}
                          onValueChange={setSourceBranchQuery}
                        />
                        <CommandList disableHorizontal>
                          {isLoadingBranches ? (
                            <div className="px-2 py-4 text-center typography-small text-muted-foreground">
                              {t('session.newWorktree.loadingBranches')}
                            </div>
                          ) : localBranches.length === 0 && remoteBranches.length === 0 ? (
                            <CommandEmpty>{t('session.newWorktree.noBranchesFound')}</CommandEmpty>
                          ) : (
                            <>
                              {hasSourceBranchQuery && hasSourceBranchMatches && (
                                <CommandGroup heading={t('session.newWorktree.matchingBranches')}>
                                  {sourceBranchRankedGroups.matching.map((branch) => (
                                    <CommandItem
                                      key={`${branch.source}-${branch.value}`}
                                      value={branch.value}
                                      onSelect={() => {
                                        setNewBranchState((prev) => ({ ...prev, sourceBranch: branch.value }));
                                        setSourceBranchDropdownOpen(false);
                                      }}
                                    >
                                      <span className="typography-small break-all">{branch.label}</span>
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              )}

                              {hasSourceBranchQuery && !hasSourceBranchMatches && (
                                <div className="px-2 py-1 text-center typography-small text-muted-foreground">
                                  {t('session.newWorktree.noMatchingBranches')}
                                </div>
                              )}

                              {sourceBranchRankedGroups.otherLocal.length > 0 && (
                                <>
                                  {hasSourceBranchQuery && <CommandSeparator />}
                                  <CommandGroup heading={hasSourceBranchQuery ? t('session.newWorktree.otherLocalBranches') : t('session.newWorktree.localBranches')}>
                                    {sourceBranchRankedGroups.otherLocal.map((branch) => (
                                      <CommandItem
                                        key={`local-${branch}`}
                                        value={branch}
                                        onSelect={() => {
                                          setNewBranchState((prev) => ({ ...prev, sourceBranch: branch }));
                                          setSourceBranchDropdownOpen(false);
                                        }}
                                      >
                                        <span className="typography-small break-all">{branch}</span>
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                </>
                              )}

                              {sourceBranchRankedGroups.otherRemote.length > 0 && (
                                <>
                                  {(sourceBranchRankedGroups.otherLocal.length > 0 || hasSourceBranchQuery) && (
                                    <CommandSeparator />
                                  )}
                                  <CommandGroup heading={hasSourceBranchQuery ? t('session.newWorktree.otherRemoteBranches') : t('session.newWorktree.remoteBranches')}>
                                    {sourceBranchRankedGroups.otherRemote.map((branch) => (
                                      <CommandItem
                                        key={`remote-${branch}`}
                                        value={`remotes/${branch}`}
                                        onSelect={() => {
                                          setNewBranchState((prev) => ({ ...prev, sourceBranch: `remotes/${branch}` }));
                                          setSourceBranchDropdownOpen(false);
                                        }}
                                      >
                                        <span className="typography-small break-all">{branch}</span>
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                </>
                              )}
                            </>
                          )}
                        </CommandList>
                      </Command>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {newBranchState.sourceBranch && (
                    <div className="typography-micro text-muted-foreground">
                      {t('session.newWorktree.newBranchFromSource', { source: newBranchState.sourceBranch })}
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
                        {t('session.newWorktree.issueNumber', { number: newBranchState.linkedIssue.number })}
                      </span>
                    )}
                    {newBranchState.linkedPr && (
                      <span className="typography-micro text-muted-foreground shrink-0">
                        {t('session.newWorktree.prNumber', { number: newBranchState.linkedPr.number })}
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
                          {t('session.newWorktree.includeDiffBadge')}
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
                      {validation.branchError || validation.worktreeError}
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
                  {t('session.newWorktree.actions.cancel')}
                </Button>
                <Button
                  size="sm"
                  onClick={handleCreate}
                  disabled={!canCreate || isCreating}
                  className="gap-1.5"
                >
                  {isCreating && <RiLoader4Line className="h-3.5 w-3.5 animate-spin" />}
                  {isCreating ? t('session.newWorktree.actions.creating') : t('session.newWorktree.actions.createWorktree')}
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
