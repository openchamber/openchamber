
import { toast } from '@/components/ui';
import { useSessionUIStore, type NewSessionDraftState } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { checkIsGitRepository, getGitBranches, resolveGitPrimaryRoot, resolveGitRepositoryPrefix } from '@/lib/gitApi';
import { branchNameFromTemplate, uniqueBranchName } from '@/lib/worktrees/branchNameTemplate';
import { generateBranchName } from '@/lib/git/branchNameGenerator';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { getWorktreeSetupWaitEnabled } from '@/lib/openchamberConfig';
import {
  resolveWorktreeSetupCommands,
  resolveWorktreeSetupCommandsOrCancel,
} from '@/lib/sharedTrustConfirmation';
import {
  removeProjectWorktree,
  type ProjectRef,
} from '@/lib/worktrees/worktreeManager';
import { createWorktreeWithDefaults, resolveDefaultWorktreeStartRef } from '@/lib/worktrees/worktreeCreate';
import { selectWorktreeStartFrom, type WorktreeStartPlace } from '@/lib/worktrees/worktreeStartSource';
import {
  createPendingDraftWorktreeRequest,
  rejectPendingDraftWorktreeRequest,
  resolvePendingDraftWorktreeRequest,
  waitForPendingDraftWorktreeRequest,
} from '@/lib/worktrees/pendingDraftWorktree';
import { waitForWorktreeBootstrap } from '@/lib/worktrees/worktreeBootstrap';
import { resolveCreatedWorktreeStartDirectory } from '@/lib/worktrees/worktreeStartDirectory';
import { projectPathForCheckoutFolder } from '@/lib/worktrees/worktreePaths';
import { normalizePath } from '@/lib/pathNormalization';
import { resolveProjectForDirectory } from '@/lib/projectResolution';

const waitForWorktreeBootstrapIfEnabled = async (project: ProjectRef, directory: string): Promise<void> => {
  if (await getWorktreeSetupWaitEnabled(project)) {
    await waitForWorktreeBootstrap(directory);
  }
};

export const resolveProjectRef = (directory: string): ProjectRef | null => {
  const projects = useProjectsStore.getState().projects;
  const normalizedDirectory = normalizePath(directory);
  if (!normalizedDirectory) return null;

  let project: (typeof projects)[number] | null = null;
  let matchedWorktreePathLength = -1;
  for (const [projectPath, worktrees] of useSessionUIStore.getState().availableWorktreesByProject) {
    for (const worktree of worktrees) {
      const worktreePath = normalizePath(worktree.path);
      if (!worktreePath) continue;
      if (normalizedDirectory !== worktreePath && !normalizedDirectory.startsWith(`${worktreePath}/`)) continue;
      if (worktreePath.length <= matchedWorktreePathLength) continue;

      const ownerPaths = [worktree.projectDirectory, projectPath];
      for (const ownerPath of ownerPaths) {
        const owner = projects.find((candidate) => normalizePath(candidate.path) === normalizePath(ownerPath))
          ?? resolveProjectForDirectory(projects, ownerPath);
        if (!owner) continue;
        project = owner;
        matchedWorktreePathLength = worktreePath.length;
        break;
      }
    }
  }

  project ??= resolveProjectForDirectory(projects, normalizedDirectory);
  return project ? { id: project.id, path: project.path } : null;
};

export const resolveFolderProjectRef = async (directory: string): Promise<ProjectRef | null> => {
  const owner = resolveProjectRef(directory);
  const located = await Promise.all([resolveGitRepositoryPrefix(directory), resolveGitPrimaryRoot(directory)])
    .then(([folder, primaryRoot]) => ({ folder, primaryRoot }), () => null);
  if (!located) return owner;
  const projects = useProjectsStore.getState().projects;
  const projectPath = projectPathForCheckoutFolder({ directory, ...located, projectPaths: projects.map((entry) => entry.path) });
  const project = projectPath ? projects.find((entry) => normalizePath(entry.path) === projectPath) : undefined;
  return project ? { id: project.id, path: project.path } : owner;
};

/**
 * A worktree named `preferredName` (random when absent). Its branch is that
 * name, or with `templated` the Settings branch template filled with it,
 * suffixed when a local branch already has the result.
 */
export const createQuickWorktree = async (
  project: ProjectRef,
  options: { preferredName?: string; startRef?: string; templated?: boolean; cancelOnTrustDismiss?: boolean } = {},
) => {
  const preferredName = options.preferredName ?? generateBranchName();
  const setupCommands = options.cancelOnTrustDismiss
    ? await resolveWorktreeSetupCommandsOrCancel(project)
    : await resolveWorktreeSetupCommands(project);
  if (setupCommands === null) {
    return null;
  }
  const branchName = options.templated ? await templatedBranchName(project.path, preferredName) : preferredName;
  return createWorktreeWithDefaults(project, {
    preferredName,
    mode: 'new',
    branchName,
    worktreeName: preferredName,
    startRef: options.startRef,
    setupCommands,
    returnAfterDirectoryCreated: true,
  });
};

const templatedBranchName = async (projectDirectory: string, name: string): Promise<string> => {
  const branches = await getGitBranches(projectDirectory, { remote: 'local' });
  const local = new Set(branches.all.filter((branch) => !branch.startsWith('remotes/')));
  return uniqueBranchName(branchNameFromTemplate(useConfigStore.getState().settingsWorktreeBranchTemplate, { name }), local);
};

let isCreatingWorktreeSession = false;



const initializeSessionForWorktree = (sessionId: string, startDirectory: string, metadata: {
  path: string;
  projectDirectory: string;
  branch: string;
  label: string;
  name?: string;
  createdFromBranch?: string;
  kind?: 'pr' | 'standard';
}) => {
  const sessionStore = useSessionUIStore.getState();
  sessionStore.initializeNewOpenChamberSession(sessionId, useConfigStore.getState().agents);
  sessionStore.setSessionDirectory(sessionId, startDirectory);
  sessionStore.setWorktreeMetadata(sessionId, metadata, startDirectory);
  useDirectoryStore.getState().setDirectory(startDirectory, { showOverlay: false });
};


const rollBackCancelledDraftWorktree = (
  requestId: string,
  previousDraft: NewSessionDraftState,
): void => {
  const sessionStore = useSessionUIStore.getState();
  void waitForPendingDraftWorktreeRequest(requestId).catch(() => undefined);
  rejectPendingDraftWorktreeRequest(requestId, new Error('Worktree creation cancelled'));
  if (!previousDraft.open) {
    sessionStore.resolvePendingDraftWorktreeTarget(requestId, null);
    sessionStore.closeNewSessionDraft();
    return;
  }
  sessionStore.overrideNewSessionDraftTarget({
    selectedProjectId: previousDraft.selectedProjectId,
    directoryOverride: previousDraft.directoryOverride,
    pendingWorktreeRequestId: previousDraft.pendingWorktreeRequestId ?? null,
    bootstrapPendingDirectory: previousDraft.bootstrapPendingDirectory ?? null,
    preserveDirectoryOverride: previousDraft.preserveDirectoryOverride === true,
    title: previousDraft.title,
    initialPrompt: previousDraft.initialPrompt,
  });
};

const createInstantWorktreeDraft = async (options?: {
  initialPrompt?: string;
  title?: string;
}): Promise<string | null> => {
  const currentDraft = useSessionUIStore.getState().newSessionDraft;
  if (currentDraft.open && currentDraft.target === 'chat') {
    return null;
  }

  if (isCreatingWorktreeSession) {
    return null;
  }

  const activeProject = useProjectsStore.getState().getActiveProject();
  if (!activeProject?.path) {
    toast.error('No active project', {
      description: 'Please select a project first.',
    });
    return null;
  }

  const projectDirectory = activeProject.path;

  let isGitRepo = false;
  try {
    isGitRepo = await checkIsGitRepository(projectDirectory);
  } catch {
    // Ignore errors, treat as not a git repo
  }

  if (!isGitRepo) {
    toast.error('Not a Git repository', {
      description: 'Worktrees can only be created in Git repositories.',
    });
    return null;
  }

  isCreatingWorktreeSession = true;

  try {
    const projectRef: ProjectRef = { id: activeProject.id, path: projectDirectory };
    const previousDraft = useSessionUIStore.getState().newSessionDraft;
    const pendingRequestId = createPendingDraftWorktreeRequest();

    const sessionStore = useSessionUIStore.getState();
    if (previousDraft.open) {
      sessionStore.overrideNewSessionDraftTarget({
        projectId: projectRef.id,
        directoryOverride: previousDraft.directoryOverride ?? projectRef.path,
        pendingWorktreeRequestId: pendingRequestId,
        preserveDirectoryOverride: true,
        title: options?.title,
        initialPrompt: options?.initialPrompt,
      });
    } else {
      sessionStore.openNewSessionDraft({
        selectedProjectId: projectRef.id,
        directoryOverride: projectRef.path,
        pendingWorktreeRequestId: pendingRequestId,
        preserveDirectoryOverride: true,
        title: options?.title,
        initialPrompt: options?.initialPrompt,
      });
    }

    const preferredName = generateBranchName();
    const startRef = await resolveDefaultWorktreeStartRef(projectRef.path, selectWorktreeStartFrom(useConfigStore.getState(), 'quick'));

    const metadata = await createQuickWorktree(projectRef, { preferredName, startRef, templated: true, cancelOnTrustDismiss: true });
    if (!metadata) {
      rollBackCancelledDraftWorktree(pendingRequestId, previousDraft);
      return null;
    }

    resolvePendingDraftWorktreeRequest(pendingRequestId, metadata.path);
    useSessionUIStore.getState().overrideNewSessionDraftTarget({
      projectId: projectRef.id,
      directoryOverride: metadata.path,
      pendingWorktreeRequestId: null,
      bootstrapPendingDirectory: metadata.path,
      preserveDirectoryOverride: true,
      title: options?.title,
      initialPrompt: options?.initialPrompt,
    });
    useDirectoryStore.getState().setDirectory(metadata.path, { showOverlay: false });

    return metadata.path;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create worktree';
    const requestId = useSessionUIStore.getState().newSessionDraft.pendingWorktreeRequestId;
    if (requestId) {
      rejectPendingDraftWorktreeRequest(requestId, error instanceof Error ? error : new Error(message));
      useSessionUIStore.getState().resolvePendingDraftWorktreeTarget(requestId, null);
    }
    useSessionUIStore.getState().setDraftBootstrapPendingDirectory(null);
    toast.error('Failed to create worktree', {
      description: message,
    });
    return null;
  } finally {
    isCreatingWorktreeSession = false;
  }
};

export async function createWorktreeSession(): Promise<string | null> {
  return createInstantWorktreeDraft();
}

export async function createWorktreeDraft(options?: { initialPrompt?: string; title?: string }): Promise<string | null> {
  return createInstantWorktreeDraft(options);
}

export async function createWorktreeSessionForNewBranch(
  projectDirectory: string,
  preferredBranchName: string,
  startPoint?: string,
  options?: {
    /**
     * Where the worktree is made: its start follows Settings for that place
     * when no start point is given, and its branch follows the Settings
     * branch template.
     */
    place?: WorktreeStartPlace;
    kind?: 'pr' | 'standard';
    worktreeName?: string;
    setUpstream?: boolean;
    upstreamRemote?: string;
    upstreamBranch?: string;
    ensureRemoteName?: string;
    ensureRemoteUrl?: string;
    createdFromBranch?: string;
    returnAfterDirectoryCreated?: boolean;
  }
): Promise<{ id: string; branch: string; path: string; directory: string } | null> {
  if (isCreatingWorktreeSession) {
    return null;
  }

  isCreatingWorktreeSession = true;

  try {
    const base = preferredBranchName?.trim();
    if (!base) {
      throw new Error('Branch name is required');
    }

    const kind = options?.kind ?? 'standard';

    const projectRef = resolveProjectRef(projectDirectory);
    if (!projectRef) {
      throw new Error('Project is not registered in OpenChamber');
    }

    let isGitRepo = false;
    try {
      isGitRepo = await checkIsGitRepository(projectRef.path);
    } catch {
      // ignore
    }

    if (!isGitRepo) {
      toast.error('Not a Git repository', {
        description: 'Worktrees can only be created in Git repositories.',
      });
      return null;
    }

    const setupCommands = await resolveWorktreeSetupCommands(projectRef);
    const rootBranch = await getRootBranch(projectRef.path);
    try {
      const start = startPoint?.trim()
        || (options?.place ? await resolveDefaultWorktreeStartRef(projectRef.path, selectWorktreeStartFrom(useConfigStore.getState(), options.place)) : undefined)
        || 'HEAD';
      const branchName = options?.place ? await templatedBranchName(projectRef.path, base) : base;
      const metadata = await createWorktreeWithDefaults(projectRef, {
        preferredName: base,
        mode: 'new',
        branchName,
        worktreeName: options?.worktreeName || base,
        startRef: start,
        setUpstream: options?.setUpstream,
        upstreamRemote: options?.upstreamRemote,
        upstreamBranch: options?.upstreamBranch,
        ensureRemoteName: options?.ensureRemoteName,
        ensureRemoteUrl: options?.ensureRemoteUrl,
        setupCommands,
        returnAfterDirectoryCreated: options?.returnAfterDirectoryCreated,
      });
      const createdMetadata = {
        ...metadata,
        // Integrate commits moves work onto this local branch: `main` for `remotes/origin/main`.
        createdFromBranch: options?.createdFromBranch || (start === 'HEAD' ? rootBranch || start : start.replace(/^remotes\/[^/]+\//, '')),
        kind,
      };

      await waitForWorktreeBootstrapIfEnabled(projectRef, metadata.path);

      const sessionStore = useSessionUIStore.getState();
      const startDirectory = await resolveCreatedWorktreeStartDirectory(projectRef, metadata);
      const session = await sessionStore.createSession(undefined, startDirectory);
      if (!session) {
        await removeProjectWorktree(projectRef, metadata, { deleteLocalBranch: true }).catch(() => undefined);
        throw new Error('Could not create a session for the worktree.');
      }

      initializeSessionForWorktree(session.id, startDirectory, createdMetadata);

      return { id: session.id, branch: metadata.branch || branchName, path: metadata.path, directory: startDirectory };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create worktree session';
      toast.error('Failed to create worktree', { description: message });
      return null;
    }
  } finally {
    isCreatingWorktreeSession = false;
  }
}
