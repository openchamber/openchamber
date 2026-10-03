import * as React from 'react';
import type { AttachIssueRequest } from '@openchamber/sdk';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { SettingsRadioGroup, SettingsRadioOption } from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { GuestAttachDialog } from '@/components/layout/GuestAttachDialog';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { useGuestAttachItems } from '@/hooks/useGuestSurfaces';
import { guestWorktreeBranch } from '@/lib/guests/start-session';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSourceControlAuthEntry } from '@/stores/useSourceControlAuthStore';
import { formatChangeRequestReference, GITHUB_SOURCE_CONTROL_IDENTITY } from '@/lib/source-control/identity';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { validateWorktreeCreate } from '@/lib/worktrees/worktreeManager';
import { createWorktreeWithDefaults } from '@/lib/worktrees/worktreeCreate';
import { waitForWorktreeBootstrap } from '@/lib/worktrees/worktreeBootstrap';
import { resolveWorktreeSetupCommands } from '@/lib/sharedTrustConfirmation';
import { getProjectSetup } from '@/lib/openchamberConfig';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { generateBranchSlug } from '@/lib/git/branchNameGenerator';
import { handleWorktreeCreateKeyDown } from './worktreeCreateKeyboard';
import { NewWorktreeBranchPicker } from './NewWorktreeBranchPicker';
import { resolveDefaultSourceBranch } from '@/lib/worktrees/worktreeSourceBranchPreference';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useGitBranches, useGitStore, useGitLoadingBranches } from '@/stores/useGitStore';
import { ReferencePickerDialog, type ReferencePickerConfirmFailure } from '@/components/references/ReferencePickerDialog';
import { referencePickerItemKey, type ReferencePickerSelection } from '@/components/references/referencePickerItems';
import { readLinearIssueDetail, useGitHubReadContext } from '@/components/references/referenceSources';
import { resolveComposerReferences } from '@/components/references/resolveComposerReferences';
import { usePendingComposerReferences } from '@/components/chat/composer/pendingComposerReferences';
import { useInputStore } from '@/sync/input-store';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Icon } from "@/components/icon/Icon";
import type { SourceControlReadContext } from '@/lib/api/types';
import { resolvePrWorktreeConfig, type PrWorktreeSource } from './prWorktreeConfig';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import type { CreateWorktreeArgs, ProjectRef } from '@/lib/worktrees/worktreeManager';
import { useI18n } from '@/lib/i18n';

/** The dialog's tabs: a fresh branch, a branch that exists, or the branch of an issue or PR. */
type Mode = 'new-branch' | 'existing-branch' | 'from-item';

interface ValidationState {
  isValidating: boolean;
  branchError: string | null;
  worktreeError: string | null;
  touched: boolean;
}

/** A branch to create, and the worktree folder named after it until the user renames the folder. */
interface BranchDraft {
  branchName: string;
  worktreeName: string;
  isSyncingWorktreeName: boolean;
}

/**
 * What a "PR or issue" worktree is for. A PR checks out its own branch; the
 * others get a new branch named after them. `selection` is the picker's choice,
 * handed to the new draft's composer as a chip.
 */
type LinkedItem =
  | {
    kind: 'pr';
    pr: PrWorktreeSource & { title: string; url: string };
    /** The account and repository the PR's branch is fetched through. */
    context: SourceControlReadContext;
    includeDiff: boolean;
    selection: ReferencePickerSelection;
  }
  | { kind: 'issue'; number: number; title: string; url: string; selection: ReferencePickerSelection }
  | { kind: 'linear'; identifier: string; title: string; url: string; selection: ReferencePickerSelection }
  | { kind: 'guest'; guest: AttachIssueRequest };

interface ExistingBranchState {
  selectedBranch: string;
  worktreeName: string;
}

const EMPTY_DRAFT: BranchDraft = { branchName: '', worktreeName: '', isSyncingWorktreeName: true };

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

interface NewWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project to create in; the sidebar's active project when absent. A draft passes its own. */
  project?: { id: string; path: string };
  /** The dialog is closed by then; a chosen issue or PR follows as a composer chip. */
  onWorktreeCreated?: (worktreePath: string) => void;
}

export function NewWorktreeDialog({
  open,
  onOpenChange,
  project,
  onWorktreeCreated,
}: NewWorktreeDialogProps) {
  const { t } = useI18n();
  const { sourceControl, git, linear } = useRuntimeAPIs();
  const trustConfirmation = useConfirmDialog();
  const isMobile = useUIStore((state) => state.isMobile);
  const githubAuthEntry = useSourceControlAuthEntry(GITHUB_SOURCE_CONTROL_IDENTITY);
  const githubAuthStatus = githubAuthEntry?.status ?? null;
  const githubAuthChecked = githubAuthEntry?.hasChecked ?? false;
  const linearAuthStatus = useLinearAuthStore((state) => state.status);
  const linearAuthChecked = useLinearAuthStore((state) => state.hasChecked);
  const guestAttachItems = useGuestAttachItems();
  const dialogGuests = React.useMemo(
    () => guestAttachItems.filter((item) => item.mode === 'dialog'),
    [guestAttachItems],
  );
  const [guestDialogId, setGuestDialogId] = React.useState<string | null>(null);
  const [referencePickerSource, setReferencePickerSource] = React.useState<'github' | 'linear' | null>(null);
  const activeProject = useProjectsStore((state) => state.getActiveProject());
  const projectId = project?.id ?? activeProject?.id ?? null;
  const projectDirectory = project?.path ?? activeProject?.path ?? null;
  const projectRef: ProjectRef | null = React.useMemo(
    () => (projectId && projectDirectory ? { id: projectId, path: projectDirectory } : null),
    [projectDirectory, projectId],
  );

  // Each tab keeps its own fields while the user switches between them.
  const [mode, setMode] = React.useState<Mode>('new-branch');
  const [newBranch, setNewBranch] = React.useState<BranchDraft>(EMPTY_DRAFT);
  const [itemBranch, setItemBranch] = React.useState<BranchDraft>(EMPTY_DRAFT);
  const [linked, setLinked] = React.useState<LinkedItem | null>(null);
  const [existingBranch, setExistingBranch] = React.useState<ExistingBranchState>({ selectedBranch: '', worktreeName: '' });
  const [sourceBranch, setSourceBranch] = React.useState('');
  // The project's setup commands, editable for this one worktree.
  const [setupBaseline, setSetupBaseline] = React.useState('');
  const [setupDraft, setSetupDraft] = React.useState('');

  // Use cached branches from Git store (instant if already fetched)
  const branches = useGitBranches(projectDirectory);
  const isLoadingBranches = useGitLoadingBranches(projectDirectory);
  const fetchBranches = useGitStore((state) => state.fetchBranches);

  const localBranches = React.useMemo(() => {
    if (!branches?.all) return [];
    return branches.all.filter((branchName: string) => !branchName.startsWith('remotes/')).sort();
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

  const canFetchBranches = Boolean(projectDirectory && git);
  const handleFetchBranches = React.useCallback(() => {
    if (!projectDirectory || !git) return;
    void fetchBranches(projectDirectory, git);
  }, [projectDirectory, git, fetchBranches]);

  React.useEffect(() => {
    if (!open || !projectDirectory || !git) return;
    if (branches?.all) return;
    void fetchBranches(projectDirectory, git);
  }, [open, projectDirectory, git, branches?.all, fetchBranches]);

  const [validation, setValidation] = React.useState<ValidationState>({
    isValidating: false,
    branchError: null,
    worktreeError: null,
    touched: false,
  });
  const [isCreating, setIsCreating] = React.useState(false);
  const [validationAbortController, setValidationAbortController] = React.useState<AbortController | null>(null);
  const initializedForCurrentOpen = React.useRef(false);

  const linkedPr = mode === 'from-item' && linked?.kind === 'pr' ? linked.pr : null;
  const linkedPrContext = mode === 'from-item' && linked?.kind === 'pr' ? linked.context : null;
  const githubContext = useGitHubReadContext(open ? projectDirectory : null);
  // The fields the visible tab edits.
  const draft = mode === 'from-item' ? itemBranch : newBranch;
  const setDraft = mode === 'from-item' ? setItemBranch : setNewBranch;
  const branchName = mode === 'existing-branch' ? existingBranch.selectedBranch : draft.branchName;
  const worktreeName = mode === 'existing-branch' ? existingBranch.worktreeName : draft.worktreeName;
  const startsNewBranch = mode === 'new-branch' || (mode === 'from-item' && !linkedPr);

  // Start from the branch the project root is on, once branches are known.
  React.useEffect(() => {
    if (!open || !branches?.all || !projectDirectory || sourceBranch) return;
    let cancelled = false;
    void getRootBranch(projectDirectory).catch(() => null).then((rootBranch) => {
      if (cancelled) return;
      const preferred = resolveDefaultSourceBranch({ branches: branches.all, rootBranch });
      if (preferred) setSourceBranch((current) => current || preferred);
    });
    return () => {
      cancelled = true;
    };
  }, [open, branches?.all, projectDirectory, sourceBranch]);

  // The setup commands a new worktree will run, shown so a slow creation is no surprise.
  React.useEffect(() => {
    if (!open || !projectRef) return;
    let cancelled = false;
    void getProjectSetup(projectRef)
      .then((setup) => {
        if (cancelled) return;
        const commands = setup.setupWorktree.join('\n');
        setSetupBaseline(commands);
        setSetupDraft(commands);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, projectRef]);

  // Reset state on each open. Resetting on close would empty the form during
  // the close animation, causing visible flicker.
  React.useLayoutEffect(() => {
    if (!open) {
      initializedForCurrentOpen.current = false;
      return;
    }
    if (initializedForCurrentOpen.current) return;
    initializedForCurrentOpen.current = true;

    const uniqueSlug = generateUniqueSlug();
    setMode('new-branch');
    setNewBranch({ branchName: uniqueSlug, worktreeName: uniqueSlug, isSyncingWorktreeName: true });
    setItemBranch(EMPTY_DRAFT);
    setLinked(null);
    setExistingBranch({ selectedBranch: '', worktreeName: '' });
    setSourceBranch('');
    setSetupBaseline('');
    setSetupDraft('');
    setValidation({ isValidating: false, branchError: null, worktreeError: null, touched: false });
  }, [open, generateUniqueSlug]);

  // The folder follows the branch name until the user renames the folder.
  React.useEffect(() => {
    if (!newBranch.isSyncingWorktreeName) return;
    const synced = slugifyWorktreeName(normalizeBranchName(newBranch.branchName));
    if (synced !== newBranch.worktreeName) setNewBranch((prev) => ({ ...prev, worktreeName: synced }));
  }, [newBranch.branchName, newBranch.isSyncingWorktreeName, newBranch.worktreeName]);
  React.useEffect(() => {
    if (!itemBranch.isSyncingWorktreeName) return;
    const synced = slugifyWorktreeName(normalizeBranchName(itemBranch.branchName));
    if (synced !== itemBranch.worktreeName) setItemBranch((prev) => ({ ...prev, worktreeName: synced }));
  }, [itemBranch.branchName, itemBranch.isSyncingWorktreeName, itemBranch.worktreeName]);

  // Validation - only runs after fields are touched
  const validateInputs = React.useCallback(async () => {
    if (!projectRef || !validation.touched || isCreating) return;

    if (validationAbortController) {
      validationAbortController.abort();
    }
    const abortController = new AbortController();
    setValidationAbortController(abortController);
    setValidation(prev => ({ ...prev, isValidating: true }));

    try {
      const normalizedBranch = normalizeBranchName(branchName);
      const normalizedWorktree = slugifyWorktreeName(worktreeName);
      let branchError: string | null = normalizedBranch ? null : t('session.newWorktree.error.branchNameRequired');
      let worktreeError: string | null = normalizedWorktree ? null : t('session.newWorktree.error.worktreeDirectoryRequired');

      if (normalizedBranch && normalizedWorktree) {
        const prConfig = linkedPr && linkedPrContext
          ? resolvePrWorktreeConfig(linkedPr, linkedPrContext, branches?.branches ?? {})
          : null;
        const validateArgs: CreateWorktreeArgs = {
          mode: mode === 'existing-branch' || prConfig ? 'existing' : 'new',
          branchName: normalizedBranch,
          worktreeName: normalizedWorktree,
          existingBranch: prConfig?.existingBranch ?? (mode === 'existing-branch' ? normalizedBranch : undefined),
        };
        if (prConfig?.expectedRevision) validateArgs.expectedRevision = prConfig.expectedRevision;
        if (prConfig?.changeRequestSource) validateArgs.changeRequestSource = prConfig.changeRequestSource;
        const result = await validateWorktreeCreate(projectRef, validateArgs);
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
        setValidation(prev => ({ ...prev, isValidating: false, branchError, worktreeError }));
      }
    } catch {
      if (!abortController.signal.aborted) {
        setValidation(prev => ({ ...prev, isValidating: false }));
      }
    }
  }, [
    projectRef,
    mode,
    branchName,
    worktreeName,
    linkedPr,
    linkedPrContext,
    branches?.branches,
    validation.touched,
    validationAbortController,
    isCreating,
    t,
  ]);

  // Trigger validation on input changes (only after touched)
  React.useEffect(() => {
    if (!open || !projectRef || !validation.touched || isCreating) return;
    const timer = setTimeout(() => {
      void validateInputs();
    }, 300);
    return () => clearTimeout(timer);
  }, [worktreeName, branchName, open, projectRef, validateInputs, validation.touched, isCreating]);

  // Hands the chosen item to the new draft's composer as a chip; the user
  // writes the first message. Its context is read here, where the item's
  // project is known; reading takes a moment, so the draft opens first.
  const attachLinkedItem = (item: LinkedItem) => {
    if (item.kind === 'guest') {
      useInputStore.getState().setPendingGuestIssue(item.guest);
      return;
    }
    void resolveComposerReferences([item.selection], {
      sourceControl,
      context: item.kind === 'pr' ? item.context : (githubContext && githubContext !== 'missing' ? githubContext : null),
      readLinearDetail: (issueId) => (linear
        ? readLinearIssueDetail(linear, issueId)
        : Promise.reject(new Error('Linear is not available here'))),
    }).then(({ references, failures }) => {
      if (references.length > 0) usePendingComposerReferences.getState().push(references);
      const failure = failures[0];
      if (failure) {
        toast.error(t('session.newWorktree.error.attachLinkedFailed', { item: failure.label }), { description: failure.error });
      }
    });
  };

  const handleCreate = async () => {
    if (!projectRef || !projectDirectory) {
      toast.error(t('session.newWorktree.error.noActiveProject'));
      return;
    }
    setValidation(prev => ({ ...prev, touched: true }));

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
    setValidation((prev) => ({ ...prev, isValidating: false, branchError: null, worktreeError: null }));
    setIsCreating(true);

    try {
      const item = mode === 'from-item' ? linked : null;
      // Untouched, the project's commands go through the usual trust prompt;
      // edited, the user has written exactly what should run.
      const resolvedSetupCommands = setupDraft === setupBaseline
        ? await resolveWorktreeSetupCommands(projectRef)
        : setupDraft.split('\n').map((line) => line.trim()).filter(Boolean);

      let sourceLabel = '';
      const args: CreateWorktreeArgs = (() => {
        if (linkedPr) {
          if (!linkedPrContext) throw new Error(t('session.newWorktree.error.changeRequestAuthorityMissing'));
          // The server fetches the PR's head through the repository's account
          // and checks it is still the revision the picker showed.
          const prConfig = resolvePrWorktreeConfig(linkedPr, linkedPrContext, branches?.branches ?? {});
          sourceLabel = prConfig.sourceLabel;
          return {
            preferredName: normalizedBranch || normalizedWorktree,
            mode: 'existing',
            branchName: normalizedBranch,
            worktreeName: normalizedWorktree,
            existingBranch: prConfig.existingBranch,
            setupCommands: resolvedSetupCommands,
            returnAfterDirectoryCreated: true,
            expectedRevision: prConfig.expectedRevision,
            changeRequestSource: prConfig.changeRequestSource,
          };
        }

        sourceLabel = startsNewBranch ? sourceBranch : '';
        const baseArgs: CreateWorktreeArgs = {
          preferredName: normalizedBranch || normalizedWorktree,
          mode: mode === 'existing-branch' ? 'existing' : 'new',
          branchName: mode === 'existing-branch' ? undefined : normalizedBranch,
          worktreeName: normalizedWorktree,
          existingBranch: mode === 'existing-branch' ? normalizedBranch : undefined,
          setupCommands: resolvedSetupCommands,
          returnAfterDirectoryCreated: true,
        };
        if (sourceBranch && startsNewBranch) baseArgs.startRef = sourceBranch;
        return baseArgs;
      })();

      const metadata = await createWorktreeWithDefaults(projectRef, args);

      // A contributor's fork may carry hooks or setup commands; they run only
      // when the user says so, after the checkout is ready.
      if (metadata.provenance?.kind === 'contributor-fork') {
        await waitForWorktreeBootstrap(metadata.path);
        const trust = await git.inspectCheckoutTrust(metadata.path);
        if (trust.actions.length > 0) {
          const run = await trustConfirmation.confirm({
            title: t('session.newWorktree.trust.title'),
            message: t('session.newWorktree.trust.confirmation', { actions: trust.actions.map((action) => action.label).join('\n') }),
            action: t('session.newWorktree.trust.run'),
          });
          await git.decideCheckoutTrust(metadata.path, trust.digest, run ? 'run' : 'skip');
        }
      }

      onOpenChange(false);
      setIsCreating(false);
      // The draft opens in the new worktree before the chosen item arrives,
      // so its chip lands on that draft's composer and not the one behind.
      onWorktreeCreated?.(metadata.path);

      toast.success(t('session.newWorktree.toast.worktreeCreated'), {
        description: t('session.newWorktree.toast.worktreeCreatedDescription', {
          target: `${metadata.branch || metadata.name}${sourceLabel ? ` ${t('session.newWorktree.fromSource', { source: sourceLabel })}` : ''}`,
        }),
      });

      if (item) attachLinkedItem(item);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('session.newWorktree.error.createWorktreeFailed');
      toast.error(t('session.newWorktree.error.createWorktreeFailed'), { description: message });
    } finally {
      setIsCreating(false);
    }
  };

  const handleModeChange = (newMode: Mode) => {
    setMode(newMode);
    setValidation(prev => ({ ...prev, touched: false, branchError: null, worktreeError: null }));
  };

  // A chosen item names the branch the worktree gets; a PR brings its own.
  const linkItem = (item: LinkedItem, branch: string) => {
    setLinked(item);
    setItemBranch({ branchName: branch, worktreeName: slugifyWorktreeName(branch), isSyncingWorktreeName: true });
    setValidation(prev => ({ ...prev, touched: false, branchError: null, worktreeError: null }));
  };

  const handleReferenceConfirm = async (selections: ReferencePickerSelection[]): Promise<ReferencePickerConfirmFailure | null> => {
    const [choice] = selections;
    if (!choice) return null;

    if (choice.source === 'linear') {
      const { issue } = choice;
      linkItem(
        { kind: 'linear', identifier: issue.identifier, title: issue.title, url: issue.url, selection: choice },
        `issue-${issue.identifier}-${generateBranchSlug()}`,
      );
      return null;
    }

    const { reference } = choice;
    if (reference.kind === 'issue') {
      linkItem(
        { kind: 'issue', number: reference.number, title: reference.title, url: reference.url, selection: choice },
        `issue-${reference.number}-${generateBranchSlug()}`,
      );
      return null;
    }

    // A PR's branch can live in one worktree only.
    if (projectRef) {
      const failure = (message: string): ReferencePickerConfirmFailure => ({ failedKeys: [referencePickerItemKey(choice)], message });
      try {
        const result = await validateWorktreeCreate(projectRef, { mode: 'new', branchName: reference.head, worktreeName: reference.head });
        if (result.errors.some((entry) => entry.code === 'branch_in_use')) {
          return failure(t('session.githubIntegration.validation.branchAlreadyCheckedOut'));
        }
      } catch {
        return failure(t('session.githubIntegration.validation.failed'));
      }
    }
    if (!githubContext || githubContext === 'missing') {
      return { failedKeys: [referencePickerItemKey(choice)], message: t('session.newWorktree.error.changeRequestAuthorityMissing') };
    }
    const pr: PrWorktreeSource & { title: string; url: string } = {
      number: reference.number,
      title: reference.title,
      url: reference.url,
      head: reference.head,
      headSha: reference.headSha,
      headProject: reference.headRepo ? { owner: reference.headRepo.owner } : null,
      project: {
        id: reference.projectId ?? `${reference.sourceRepo.owner}/${reference.sourceRepo.repo}`,
        owner: reference.sourceRepo.owner,
        name: reference.sourceRepo.repo,
      },
    };
    linkItem({ kind: 'pr', pr, context: githubContext, includeDiff: choice.includeDiff, selection: choice }, reference.head);
    return null;
  };

  const handleGuestSelect = (issue: AttachIssueRequest): void => {
    const kind = issue.kind === 'pull' ? 'pull' : 'issue';
    linkItem({ kind: 'guest', guest: issue }, `${guestWorktreeBranch(issue.id, kind)}-${generateBranchSlug()}`);
    setGuestDialogId(null);
  };

  // Only this unlinks: editing the branch name keeps the chosen item.
  const handleClearLinkedItem = () => {
    setLinked(null);
    setItemBranch(EMPTY_DRAFT);
  };

  const isGitHubConnected = githubAuthChecked && githubAuthStatus?.connected === true;
  // A GitLab project lists its issues and merge requests in the same picker,
  // read with the account its context names.
  const isGitLabProject = githubContext !== null && githubContext !== 'missing' && githubContext.provider === 'gitlab';
  const isRepositoryConnected = isGitHubConnected || isGitLabProject;
  const isLinearConnected = Boolean(linear) && linearAuthChecked && linearAuthStatus?.connected === true;
  const canLinkItems = isRepositoryConnected || isLinearConnected || dialogGuests.length > 0;

  const isFormValid = Boolean(normalizeBranchName(branchName))
    && Boolean(slugifyWorktreeName(worktreeName))
    && (mode !== 'from-item' || linked !== null)
    && !validation.branchError
    && !validation.worktreeError;
  const canCreate = isFormValid && !isCreating;

  const handleCreateKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    handleWorktreeCreateKeyDown(event, () => {
      if (!canCreate) return;
      void handleCreate();
    });
  };

  const fieldBlock = (title: string, control: React.ReactNode, hint?: string) => (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1 typography-meta font-semibold text-foreground">
        {title}
        {hint ? <SettingsInfoHint>{hint}</SettingsInfoHint> : null}
      </h3>
      {control}
    </section>
  );

  // Where the chosen item comes from: one source opens straight away, several ask which.
  const itemSources = [
    ...(isRepositoryConnected ? [isGitLabProject
      ? { id: 'github', name: 'GitLab', label: t('session.newWorktree.actions.startFromGitLabIssueMr'), icon: <Icon name="gitlab" className="size-4 shrink-0" />, open: () => setReferencePickerSource('github') }
      : { id: 'github', name: 'GitHub', label: t('session.newWorktree.actions.startFromGitHubIssuePr'), icon: <Icon name="github" className="size-4 shrink-0" />, open: () => setReferencePickerSource('github') }] : []),
    ...(isLinearConnected ? [{ id: 'linear', name: 'Linear', label: t('session.newWorktree.actions.startFromLinearIssue'), icon: <Icon name="linear" className="size-4 shrink-0" />, open: () => setReferencePickerSource('linear') }] : []),
    ...dialogGuests.map((guest) => ({
      id: guest.id,
      name: guest.name,
      label: t('session.newWorktree.actions.startFromGuest', { name: guest.name }),
      icon: <GuestIcon icon={guest.icon} iconSrc={guest.iconSrc} className="size-4 shrink-0" />,
      open: () => setGuestDialogId(guest.id),
    })),
  ];
  const itemPickerDisabled = mode !== 'from-item';

  const linkedGuestEntry = linked?.kind === 'guest'
    ? dialogGuests.find((entry) => entry.id === linked.guest.providerId)
    : undefined;
  const linkedView = linked
    ? linked.kind === 'pr'
      ? { id: linked.context.provider === 'gitlab' ? formatChangeRequestReference('gitlab', linked.pr.number) : t('session.newWorktree.prNumber', { number: linked.pr.number }), title: linked.pr.title, url: linked.pr.url, icon: <Icon name="git-pull-request" className="size-4 shrink-0 text-muted-foreground" /> }
      : linked.kind === 'issue'
        ? { id: t('session.newWorktree.issueNumber', { number: linked.number }), title: linked.title, url: linked.url, icon: <Icon name={isGitLabProject ? 'gitlab' : 'github'} className="size-4 shrink-0 text-muted-foreground" /> }
        : linked.kind === 'linear'
          ? { id: linked.identifier, title: linked.title, url: linked.url, icon: <Icon name="linear" className="size-4 shrink-0 text-muted-foreground" /> }
          : { id: linked.guest.id, title: linked.guest.title, url: linked.guest.url, icon: <GuestIcon icon={linkedGuestEntry?.icon ?? 'window'} iconSrc={linkedGuestEntry?.iconSrc} className="size-4 shrink-0" /> }
    : null;

  // One row, the height of a field, whether empty or holding the chosen item.
  const itemPicker = linkedView ? (
    <div className={cn('flex h-8 min-w-0 items-center gap-2 rounded-lg border border-border/60 px-2.5', itemPickerDisabled && 'opacity-50')}>
      {linkedView.icon}
      <span className="shrink-0 typography-micro text-muted-foreground">{linkedView.id}</span>
      <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{linkedView.title}</span>
      <a
        href={linkedView.url}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        <Icon name="external-link" className="h-3.5 w-3.5" />
      </a>
      <button
        type="button"
        onClick={handleClearLinkedItem}
        disabled={itemPickerDisabled}
        aria-label={t('session.newWorktree.actions.unlink')}
        title={t('session.newWorktree.actions.unlink')}
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
      >
        <Icon name="close" className="h-3.5 w-3.5" />
      </button>
    </div>
  ) : (
    // One button per source; extensions that attach items add theirs.
    <div className="flex min-h-8 flex-wrap items-center gap-1.5">
      {itemSources.map((source) => (
        <Button
          key={source.id}
          type="button"
          variant="outline"
          size="sm"
          disabled={itemPickerDisabled}
          onClick={source.open}
          aria-label={source.label}
          title={source.label}
          className="h-8 gap-1.5"
        >
          {source.icon}
          <span className="max-w-[10rem] truncate">{source.name}</span>
        </Button>
      ))}
    </div>
  );

  const startOptions = (
    <SettingsRadioGroup aria-label={t('session.newWorktree.start.title')}>
      <SettingsRadioOption
        selected={mode === 'new-branch'}
        onSelect={() => handleModeChange('new-branch')}
        label={t('session.newWorktree.mode.newBranch')}
        description={t('session.newWorktree.start.newBranchHint')}
      />
      <SettingsRadioOption
        selected={mode === 'existing-branch'}
        onSelect={() => handleModeChange('existing-branch')}
        label={t('session.newWorktree.mode.existingBranch')}
        description={t('session.newWorktree.start.existingBranchHint')}
      />
      <SettingsRadioOption
        selected={mode === 'from-item'}
        onSelect={() => handleModeChange('from-item')}
        disabled={!canLinkItems}
        label={t('session.newWorktree.mode.fromItem')}
        description={canLinkItems ? t('session.newWorktree.start.fromItemHint') : t('session.newWorktree.start.fromItemUnavailable')}
      />
    </SettingsRadioGroup>
  );

  // The branch row keeps its height in every mode: a name, a branch to check
  // out, or the PR's own branch.
  const branchControl = mode === 'existing-branch' ? (
    <div className="flex items-center gap-1.5">
      <div className="min-w-0 flex-1">
        <NewWorktreeBranchPicker
          value={existingBranch.selectedBranch}
          placeholder={t('session.newWorktree.chooseBranch')}
          title={t('session.newWorktree.selectBranch')}
          localBranches={localBranches}
          remoteBranches={remoteBranches}
          isLoading={isLoadingBranches}
          isMobile={isMobile}
          onSelect={(branch) => {
            setExistingBranch({ selectedBranch: branch.value, worktreeName: slugifyWorktreeName(branch.label) });
            setValidation(prev => ({ ...prev, touched: true }));
          }}
        />
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 shrink-0 px-0"
        onClick={handleFetchBranches}
        disabled={!canFetchBranches || isLoadingBranches}
        title={t('session.newWorktree.fetchBranches')}
        aria-label={t('session.newWorktree.fetchBranches')}
      >
        {isLoadingBranches ? <Icon name="loader-4" className="size-4 animate-spin" /> : <Icon name="refresh" className="size-4" />}
      </Button>
    </div>
  ) : (
    <Input
      value={draft.branchName}
      onChange={(e) => setDraft((prev) => ({ ...prev, branchName: e.target.value }))}
      onBlur={() => setValidation(prev => ({ ...prev, touched: true }))}
      onKeyDown={handleCreateKeyDown}
      // A PR brings its branch; with nothing chosen yet there is no name to give.
      disabled={mode === 'from-item' && (!linked || Boolean(linkedPr))}
      placeholder={t('session.newWorktree.branchNamePlaceholder')}
      className={cn('h-8', validation.touched && validation.branchError && 'border-destructive')}
    />
  );

  const baseBranchControl = (
    <NewWorktreeBranchPicker
      value={startsNewBranch ? sourceBranch : ''}
      placeholder={startsNewBranch ? t('session.newWorktree.selectSourceBranchPlaceholder') : t('session.newWorktree.baseBranchNotApplicable')}
      title={t('session.newWorktree.selectSourceBranch')}
      localBranches={localBranches}
      remoteBranches={remoteBranches}
      isLoading={isLoadingBranches}
      isMobile={isMobile}
      disabled={!startsNewBranch}
      onSelect={(branch) => setSourceBranch(branch.value)}
    />
  );

  const folderControl = (
    <div className="flex items-center gap-1.5">
      <Input
        value={worktreeName}
        onChange={(e) => {
          if (mode === 'existing-branch') {
            setExistingBranch((prev) => ({ ...prev, worktreeName: e.target.value }));
          } else {
            setDraft((prev) => ({ ...prev, worktreeName: e.target.value, isSyncingWorktreeName: false }));
          }
        }}
        onBlur={() => setValidation(prev => ({ ...prev, touched: true }))}
        onKeyDown={handleCreateKeyDown}
        disabled={mode === 'from-item' && !linked}
        placeholder={t('session.newWorktree.worktreeDirectoryPlaceholder')}
        className={cn('h-8 min-w-0 flex-1', validation.touched && validation.worktreeError && 'border-destructive')}
      />
      {/* Kept in place, disabled while the folder already follows the branch. */}
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 shrink-0 px-0"
        onClick={() => setDraft((prev) => ({ ...prev, isSyncingWorktreeName: true }))}
        disabled={mode === 'existing-branch' || draft.isSyncingWorktreeName}
        title={t('session.newWorktree.resetToMatchBranchName')}
        aria-label={t('session.newWorktree.resetToMatchBranchName')}
      >
        <Icon name="refresh" className="size-4" />
      </Button>
    </div>
  );

  const setupBlock = fieldBlock(
    t('session.newWorktree.setup.title'),
    <Textarea
      value={setupDraft}
      onChange={(event) => setSetupDraft(event.target.value)}
      placeholder="bun install"
      className="h-[72px] min-h-[72px] resize-none font-mono typography-micro"
    />,
    t('session.newWorktree.setup.hint'),
  );

  const choiceBlocks = (
    <>
      {fieldBlock(t('session.newWorktree.start.title'), startOptions)}
      {canLinkItems ? fieldBlock(t('session.newWorktree.item.title'), itemPicker) : null}
    </>
  );
  const branchBlocks = (
    <>
      {fieldBlock(mode === 'existing-branch' ? t('session.newWorktree.selectBranch') : t('session.newWorktree.branchName'), branchControl)}
      {fieldBlock(t('session.newWorktree.sourceBranch'), baseBranchControl)}
      {fieldBlock(t('session.newWorktree.worktreeDirectory'), folderControl)}
    </>
  );
  // Two fixed columns on desktop; one column on a phone, read top to bottom.
  const body = isMobile ? (
    <div className="flex min-w-0 flex-col gap-5">
      {choiceBlocks}
      {branchBlocks}
      {setupBlock}
    </div>
  ) : (
    <div className="grid grid-cols-2 gap-x-10">
      <div className="flex min-w-0 flex-col gap-5">
        {choiceBlocks}
        {setupBlock}
      </div>
      <div className="flex min-w-0 flex-col gap-5">{branchBlocks}</div>
    </div>
  );

  const validationText = validation.touched ? (validation.branchError || validation.worktreeError) : null;
  const footer = (
    <div className={cn('flex w-full gap-2', isMobile ? 'flex-col' : 'flex-row items-center')}>
      {/* One line that never grows the dialog; the full message is its tooltip. */}
      <p
        className={cn('flex min-h-4 min-w-0 items-center gap-1.5 typography-micro text-destructive', isMobile ? 'order-first w-full' : 'flex-1')}
        title={validationText ?? undefined}
      >
        {validationText ? <Icon name="error-warning" className="h-3.5 w-3.5 shrink-0" /> : null}
        <span className="truncate">{validationText}</span>
      </p>
      <div className={cn('flex shrink-0 gap-2', isMobile && 'w-full')}>
        <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={isCreating} className={cn(isMobile && 'flex-1')}>
          {t('session.newWorktree.actions.cancel')}
        </Button>
        <Button size="sm" onClick={handleCreate} disabled={!canCreate || isCreating} className={cn('gap-1.5', isMobile && 'flex-1')}>
          {isCreating && <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" />}
          {isCreating ? t('session.newWorktree.actions.creating') : t('session.newWorktree.actions.createWorktree')}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      {isMobile ? (
        <MobileOverlayPanel open={open} title={t('session.newWorktree.title')} onClose={() => onOpenChange(false)} footer={footer}>
          {body}
        </MobileOverlayPanel>
      ) : (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>{t('session.newWorktree.title')}</DialogTitle>
              <DialogDescription className="sr-only">{t('session.newWorktree.title')}</DialogDescription>
            </DialogHeader>
            {body}
            <DialogFooter>{footer}</DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {referencePickerSource ? (
        <ReferencePickerDialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setReferencePickerSource(null);
          }}
          source={referencePickerSource}
          purpose="worktree"
          selection="single"
          directory={projectDirectory}
          onConfirm={handleReferenceConfirm}
        />
      ) : null}
      <GuestAttachDialog
        guestId={guestDialogId}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setGuestDialogId(null);
        }}
        onAttach={handleGuestSelect}
        onSessionStarted={() => onOpenChange(false)}
      />
      {trustConfirmation.dialog}
    </>
  );
}
