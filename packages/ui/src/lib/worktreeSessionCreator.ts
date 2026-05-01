/**
 * Utilities for creating worktrees and, when needed, sessions bound to them.
 * This is a standalone entrypoint for keyboard shortcuts, menu actions,
 * and other non-hook contexts.
 */

import { toast } from '@/components/ui';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextStore } from '@/stores/contextStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { checkIsGitRepository, previewGitWorktree } from '@/lib/gitApi';
import { generateBranchName } from '@/lib/git/branchNameGenerator';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { getWorktreeSetupCommands } from '@/lib/openchamberConfig';
import {
  removeProjectWorktree,
  type ProjectRef,
} from '@/lib/worktrees/worktreeManager';
import { createWorktreeWithDefaults } from '@/lib/worktrees/worktreeCreate';
import {
  createPendingDraftWorktreeRequest,
  rejectPendingDraftWorktreeRequest,
  resolvePendingDraftWorktreeRequest,
} from '@/lib/worktrees/pendingDraftWorktree';

const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '') || value;

const resolveProjectRef = (directory: string): ProjectRef | null => {
  const normalized = normalizePath(directory);
  const projects = useProjectsStore.getState().projects;
  if (projects.length === 0) {
    return null;
  }

  const activeProject = useProjectsStore.getState().getActiveProject();
  if (activeProject?.path) {
    const activePath = normalizePath(activeProject.path);
    if (normalized === activePath || normalized.startsWith(`${activePath}/`)) {
      return { id: activeProject.id, path: activeProject.path };
    }
  }

  const matches = projects.filter((project) => {
    const projectPath = normalizePath(project.path);
    return normalized === projectPath || normalized.startsWith(`${projectPath}/`);
  });

  const match = matches.sort((a, b) => normalizePath(b.path).length - normalizePath(a.path).length)[0];

  return match ? { id: match.id, path: match.path } : null;
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

    const settingsDefaultVariant = configState.settingsDefaultVariant;
    if (!settingsDefaultVariant) {
      return;
    }

    const provider = configState.providers.find((p) => p.id === providerId);
    const model = provider?.models.find((m: Record<string, unknown>) => (m as { id?: string }).id === modelId) as
      | { variants?: Record<string, unknown> }
      | undefined;
    const variants = model?.variants;

    if (variants && Object.prototype.hasOwnProperty.call(variants, settingsDefaultVariant)) {
      configState.setCurrentVariant(settingsDefaultVariant);
      useContextStore
        .getState()
        .saveAgentModelVariantForSession(sessionId, agentName, providerId, modelId, settingsDefaultVariant);
    }
  } catch {
    // Ignore errors setting default agent
  }
};

const initializeSessionForWorktree = (sessionId: string, metadata: {
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
  sessionStore.setSessionDirectory(sessionId, metadata.path);
  sessionStore.setWorktreeMetadata(sessionId, metadata);
  applyDefaultAgentAndModelSelection(sessionId, configState);
  useDirectoryStore.getState().setDirectory(metadata.path, { showOverlay: false });
};


const createInstantWorktreeDraft = async (options?: {
  initialPrompt?: string;
  title?: string;
}): Promise<string | null> => {
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
    const pendingRequestId = createPendingDraftWorktreeRequest();

    // Lock the draft immediately so no React effect can reset it to the project
    // root while we await the preview / worktree creation below.
    const sessionStore = useSessionUIStore.getState();
    if (sessionStore.newSessionDraft?.open) {
      sessionStore.overrideNewSessionDraftTarget({
        projectId: projectRef.id,
        directoryOverride: sessionStore.newSessionDraft.directoryOverride ?? projectRef.path,
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

    const preview = await previewGitWorktree(projectRef.path, {
      mode: 'new',
      branchName: preferredName,
      worktreeName: preferredName,
    }).catch(() => null);

    // Refine draft target once we know the actual worktree path from the preview.
    if (preview?.path) {
      useSessionUIStore.getState().overrideNewSessionDraftTarget({
        projectId: projectRef.id,
        directoryOverride: preview.path,
        pendingWorktreeRequestId: pendingRequestId,
        bootstrapPendingDirectory: preview.path,
        preserveDirectoryOverride: true,
        title: options?.title,
        initialPrompt: options?.initialPrompt,
      });
      useDirectoryStore.getState().setDirectory(preview.path, { showOverlay: false });
    }

    const setupCommands = await getWorktreeSetupCommands(projectRef);
    const metadata = await createWorktreeWithDefaults(projectRef, {
      preferredName,
      mode: 'new',
      branchName: preferredName,
      worktreeName: preferredName,
      setupCommands,
    });

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
export function isCreatingWorktree(): boolean {
  return isCreatingWorktreeSession;
}

export async function createWorktreeDraft(options?: { initialPrompt?: string; title?: string }): Promise<string | null> {
  return createInstantWorktreeDraft(options);
}

export async function createWorktreeOnly(): Promise<string | null> {
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
    // ignored
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
    const preferredName = generateBranchName();
    const setupCommands = await getWorktreeSetupCommands(projectRef);
    const metadata = await createWorktreeWithDefaults(projectRef, {
      preferredName,
      mode: 'new',
      branchName: preferredName,
      worktreeName: preferredName,
      setupCommands,
    });


    return metadata.path;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create worktree';
    toast.error('Failed to create worktree', {
      description: message,
    });
    return null;
  } finally {
    isCreatingWorktreeSession = false;
  }
}

/**
 * Create a new session with a worktree for a specific branch.
 * Unlike createWorktreeSession(), this allows specifying the project and branch explicitly.
 * 
 * @param projectDirectory - The root directory of the git repository
 * @param branchName - The name of the branch to create a worktree for
 * @returns The created session, or null if creation failed
 */
export async function createWorktreeSessionForBranch(
  projectDirectory: string,
  branchName: string,
  options?: {
    kind?: 'pr' | 'standard';
    existingBranch?: string;
    worktreeName?: string;
    setUpstream?: boolean;
    upstreamRemote?: string;
    upstreamBranch?: string;
    ensureRemoteName?: string;
    ensureRemoteUrl?: string;
    createdFromBranch?: string;
  }
): Promise<{ id: string } | null> {
  if (isCreatingWorktreeSession) {
    return null;
  }

  isCreatingWorktreeSession = true;

  try {
    const projectRef = resolveProjectRef(projectDirectory);
    if (!projectRef) {
      throw new Error('Project is not registered in OpenChamber');
    }

    // Check if it's a git repo (root project path)
    let isGitRepo = false;
    try {
      isGitRepo = await checkIsGitRepository(projectRef.path);
    } catch {
      // Ignore errors, treat as not a git repo
    }

    if (!isGitRepo) {
      toast.error('Not a Git repository', {
        description: 'Worktrees can only be created in Git repositories.',
      });
      return null;
    }

    const setupCommands = await getWorktreeSetupCommands(projectRef);
    const rootBranch = await getRootBranch(projectRef.path);
    const metadata = await createWorktreeWithDefaults(projectRef, {
      preferredName: branchName,
      mode: 'existing',
      existingBranch: options?.existingBranch || branchName,
      branchName,
      worktreeName: options?.worktreeName || branchName,
      setUpstream: options?.setUpstream,
      upstreamRemote: options?.upstreamRemote,
      upstreamBranch: options?.upstreamBranch,
      ensureRemoteName: options?.ensureRemoteName,
      ensureRemoteUrl: options?.ensureRemoteUrl,
      setupCommands,
    });

    const kind = options?.kind ?? 'standard';
    const createdMetadata = {
      ...metadata,
      createdFromBranch: options?.createdFromBranch || rootBranch,
      kind,
    };

    // Create the session
    const sessionStore = useSessionUIStore.getState();
    const session = await sessionStore.createSession(undefined, metadata.path);
    if (!session) {
      // Clean up the worktree if session creation failed
      await removeProjectWorktree(projectRef, metadata, { deleteLocalBranch: true }).catch(() => undefined);
      toast.error('Failed to create session', {
        description: 'Could not create a session for the worktree.',
      });
      return null;
    }

    initializeSessionForWorktree(session.id, createdMetadata);

    return session;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create worktree session';
    toast.error('Failed to create worktree', {
      description: message,
    });
    return null;
  } finally {
    isCreatingWorktreeSession = false;
  }
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
  }
): Promise<{ id: string; branch: string } | null> {
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

    const setupCommands = await getWorktreeSetupCommands(projectRef);
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
      });
      const createdMetadata = {
        ...metadata,
        createdFromBranch: options?.createdFromBranch || rootBranch || start,
        kind,
      };

      const sessionStore = useSessionUIStore.getState();
      const session = await sessionStore.createSession(undefined, metadata.path);
      if (!session) {
        await removeProjectWorktree(projectRef, metadata, { deleteLocalBranch: true }).catch(() => undefined);
        throw new Error('Could not create a session for the worktree.');
      }

      initializeSessionForWorktree(session.id, createdMetadata);

      return { id: session.id, branch: metadata.branch || base };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create worktree session';
      toast.error('Failed to create worktree', { description: message });
      return null;
    }
  } finally {
    isCreatingWorktreeSession = false;
  }
}

/**
 * Same as createWorktreeSessionForNewBranch, but preserves the exact branch name.
 * Use when the worktree must be tied to a specific ref (e.g. PR head ref).
 */
export async function createWorktreeSessionForNewBranchExact(
  projectDirectory: string,
  branchName: string,
  startPoint: string,
  options?: {
    kind?: 'pr' | 'standard';
    worktreeName?: string;
    setUpstream?: boolean;
    upstreamRemote?: string;
    upstreamBranch?: string;
    ensureRemoteName?: string;
    ensureRemoteUrl?: string;
    createdFromBranch?: string;
  }
): Promise<{ id: string; branch: string } | null> {
  return createWorktreeSessionForNewBranch(projectDirectory, branchName, startPoint, {
    kind: options?.kind,
    worktreeName: options?.worktreeName,
    setUpstream: options?.setUpstream,
    upstreamRemote: options?.upstreamRemote,
    upstreamBranch: options?.upstreamBranch,
    ensureRemoteName: options?.ensureRemoteName,
    ensureRemoteUrl: options?.ensureRemoteUrl,
    createdFromBranch: options?.createdFromBranch,
  });
}
