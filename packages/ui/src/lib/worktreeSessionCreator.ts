/**
 * Utilities for creating worktrees and, when needed, sessions bound to them.
 * This is a standalone entrypoint for keyboard shortcuts, menu actions,
 * and other non-hook contexts.
 */

import { toast } from '@/components/ui';
import { useSessionUIStore, type NewSessionDraftState } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextStore } from '@/stores/contextStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { checkIsGitRepository, resolveGitPrimaryRoot, resolveGitRepositoryPrefix } from '@/lib/gitApi';
import { generateBranchName } from '@/lib/git/branchNameGenerator';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { resolveEffortForModelSelection } from '@/lib/modelEfforts';
import { modelVariantNames } from '@/lib/modelVariants';
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
import { createWorktreeWithDefaults } from '@/lib/worktrees/worktreeCreate';
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

/**
 * The project whose folder a session in `directory` works in, for placing it
 * in another worktree. `resolveProjectRef` answers the project that owns the
 * worktree list, which is the repository root when both `repo` and `repo/ai`
 * are registered; the folder comes from where the session sits in its checkout
 * (`projectPathForCheckoutFolder`), as the server does. Falls back to
 * `resolveProjectRef` when git cannot answer.
 */
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

export const createQuickWorktree = async (
  project: ProjectRef,
  options: { preferredName?: string; startRef?: string; cancelOnTrustDismiss?: boolean } = {},
) => {
  const preferredName = options.preferredName ?? generateBranchName();
  const setupCommands = options.cancelOnTrustDismiss
    ? await resolveWorktreeSetupCommandsOrCancel(project)
    : await resolveWorktreeSetupCommands(project);
  if (setupCommands === null) {
    return null;
  }
  return createWorktreeWithDefaults(project, {
    preferredName,
    mode: 'new',
    branchName: preferredName,
    worktreeName: preferredName,
    startRef: options.startRef,
    setupCommands,
    returnAfterDirectoryCreated: true,
  });
};

// Track if a worktree creation flow is already running
let isCreatingWorktreeSession = false;



const applyDefaultAgentAndModelSelection = (sessionId: string, configState = useConfigStore.getState()) => {
  try {
    const visibleAgents = configState.getVisibleAgents();
    let agentName: string | undefined;

    if (configState.settingsDefaultAgent) {
      const settingsAgent = visibleAgents.find((a) => a.name === configState.settingsDefaultAgent);
      if (settingsAgent) {
        agentName = settingsAgent.name;
      }
    }

    if (!agentName) {
      agentName =
        visibleAgents.find((agent) => agent.name === 'build')?.name ||
        visibleAgents[0]?.name;
    }

    if (!agentName) {
      return;
    }

    configState.setAgent(agentName);
    useContextStore.getState().saveSessionAgentSelection(sessionId, agentName);

    const settingsDefaultModel = configState.settingsDefaultModel;
    if (!settingsDefaultModel) {
      return;
    }

    const parsed = parseModelIdentifier(settingsDefaultModel);
    if (!parsed) {
      return;
    }

    const { providerId, modelId } = parsed;
    const modelMetadata = configState.getModelMetadata(providerId, modelId);
    if (!modelMetadata) {
      return;
    }

    useContextStore.getState().saveSessionModelSelection(sessionId, providerId, modelId);
    useContextStore.getState().saveAgentModelForSession(sessionId, agentName, providerId, modelId);

    const provider = configState.providers.find((p) => p.id === providerId);
    const model = provider?.models.find((entry) => entry.id === modelId);
    // Same resolution as the composer: the agent's pin for this model and the
    // configured level first, then the level it was last sent with.
    const variant = resolveEffortForModelSelection({
      providerID: providerId, modelID: modelId, variants: modelVariantNames(model),
      agents: configState.agents, agentName,
      configuredVariant: configState.getDefaultVariantForModel(providerId, modelId),
    });
    if (variant === undefined) {
      return;
    }

    configState.setCurrentVariant(variant ?? undefined);
    useContextStore
      .getState()
      .saveAgentModelVariantForSession(sessionId, agentName, providerId, modelId, variant);
  } catch {
    // Ignore errors setting default agent
  }
};

/** `startDirectory` is where the session runs inside `metadata.path`; the worktree root stays the checkout. */
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
  const configState = useConfigStore.getState();
  sessionStore.initializeNewOpenChamberSession(sessionId, configState.agents);
  sessionStore.setSessionDirectory(sessionId, startDirectory);
  sessionStore.setWorktreeMetadata(sessionId, metadata, startDirectory);
  applyDefaultAgentAndModelSelection(sessionId, configState);
  useDirectoryStore.getState().setDirectory(startDirectory, { showOverlay: false });
};


const rollBackCancelledDraftWorktree = (
  requestId: string,
  previousDraft: NewSessionDraftState,
): void => {
  const sessionStore = useSessionUIStore.getState();
  // A draft that is never sent must not turn the cancel into an unhandled rejection.
  void waitForPendingDraftWorktreeRequest(requestId).catch(() => undefined);
  rejectPendingDraftWorktreeRequest(requestId, new Error('Worktree creation cancelled'));
  if (!previousDraft.open) {
    sessionStore.resolvePendingDraftWorktreeTarget(requestId, null);
    sessionStore.closeNewSessionDraft();
    return;
  }
  // Put the draft back where it was before the worktree was requested: its
  // directory target, title and "Creating..." state belong to the cancelled request.
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

    // Lock the draft immediately so no React effect can reset it to the project
    // root while we await worktree creation below.
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

    // A preview path has no bootstrap state yet. Selecting it lets background
    // OpenCode reads initialize an instance before the worktree exists.
    const metadata = await createQuickWorktree(projectRef, { preferredName, cancelOnTrustDismiss: true });
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

/**
 * Create a new worktree and open a draft scoped to it.
 * 
 * @returns The worktree path, or null if creation failed
 */
export async function createWorktreeSession(): Promise<string | null> {
  return createInstantWorktreeDraft();
}

/**
 * Check if a worktree session is currently being created.
 */
export async function createWorktreeDraft(options?: { initialPrompt?: string; title?: string }): Promise<string | null> {
  return createInstantWorktreeDraft(options);
}

/**
 * Create a worktree session for a new branch name.
 * Callers can still use startPoint for metadata or follow-up git operations.
 */
export async function createWorktreeSessionForNewBranch(
  projectDirectory: string,
  preferredBranchName: string,
  startPoint?: string,
  options?: {
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
    const start = startPoint?.trim() || 'HEAD';
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
      const metadata = await createWorktreeWithDefaults(projectRef, {
        preferredName: base,
        mode: 'new',
        branchName: base,
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
        createdFromBranch: options?.createdFromBranch || rootBranch || start,
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

      return { id: session.id, branch: metadata.branch || base, path: metadata.path, directory: startDirectory };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create worktree session';
      toast.error('Failed to create worktree', { description: message });
      return null;
    }
  } finally {
    isCreatingWorktreeSession = false;
  }
}
