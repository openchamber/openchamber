/**
 * Utilities for creating worktrees and, when needed, sessions bound to them.
 * This is a standalone entrypoint for keyboard shortcuts, menu actions,
 * and other non-hook contexts.
 */

import { toast } from '@/components/ui';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextStore } from '@/stores/contextStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { checkIsGitRepository, previewGitWorktree } from '@/lib/gitApi';
import { generateBranchName } from '@/lib/git/branchNameGenerator';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { getWorktreeSetupCommands, getWorktreeSetupWaitEnabled } from '@/lib/openchamberConfig';
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
import { waitForWorktreeBootstrap } from '@/lib/worktrees/worktreeBootstrap';
import { normalizePath } from '@/lib/pathNormalization';
import { resolveProjectForDirectory } from '@/lib/projectResolution';
import {
  isValidWorktreeSessionSelection,
  resolveWorktreeSessionSelection,
  type WorktreeSessionOverrides,
  type WorktreeSessionSelection,
} from '@/lib/worktreeSessionSelection';

export {
  resolveWorktreeSessionSelection,
  type WorktreeSessionOverrides,
  type WorktreeSessionSelection,
} from '@/lib/worktreeSessionSelection';

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

export const createQuickWorktree = async (
  project: ProjectRef,
  options: { preferredName?: string; startRef?: string } = {},
) => {
  const preferredName = options.preferredName ?? generateBranchName();
  const setupCommands = await getWorktreeSetupCommands(project);
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



export const applyDefaultAgentAndModelSelection = (
  sessionId: string,
  configState = useConfigStore.getState(),
  overrides?: WorktreeSessionOverrides,
  selection = resolveWorktreeSessionSelection(configState, overrides),
): WorktreeSessionSelection | null => {
  try {
    if (!selection) {
      return null;
    }

    configState.setAgent(selection.agentName);
    const selectionStore = useSelectionStore.getState();
    selectionStore.saveSessionAgentSelection(sessionId, selection.agentName);
    selectionStore.saveSessionModelSelection(sessionId, selection.providerID, selection.modelID);
    selectionStore.saveAgentModelForSession(sessionId, selection.agentName, selection.providerID, selection.modelID);
    selectionStore.saveAgentModelVariantForSession(
      sessionId,
      selection.agentName,
      selection.providerID,
      selection.modelID,
      selection.variant,
    );

    const contextStore = useContextStore.getState();
    contextStore.saveSessionAgentSelection(sessionId, selection.agentName);
    contextStore.saveSessionModelSelection(sessionId, selection.providerID, selection.modelID);
    contextStore.saveAgentModelForSession(sessionId, selection.agentName, selection.providerID, selection.modelID);

    if (selection.variant !== undefined) {
      configState.setCurrentVariant(selection.variant);
    }
    contextStore.saveAgentModelVariantForSession(
      sessionId,
      selection.agentName,
      selection.providerID,
      selection.modelID,
      selection.variant,
    );

    return selection;
  } catch (error) {
    console.warn('[worktreeSessionCreator] applyDefaultAgentAndModelSelection failed', error);
    return null;
  }
};

const initializeSessionForWorktree = (
  sessionId: string,
  metadata: {
    path: string;
    projectDirectory: string;
    branch: string;
    label: string;
    name?: string;
    createdFromBranch?: string;
    kind?: 'pr' | 'standard';
  },
  overrides?: WorktreeSessionOverrides,
  selection?: WorktreeSessionSelection | null,
) => {
  const sessionStore = useSessionUIStore.getState();
  const configState = useConfigStore.getState();
  sessionStore.initializeNewOpenChamberSession(sessionId, configState.agents);
  sessionStore.setSessionDirectory(sessionId, metadata.path);
  sessionStore.setWorktreeMetadata(sessionId, metadata);
  applyDefaultAgentAndModelSelection(sessionId, configState, overrides, selection);
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

    const metadata = await createQuickWorktree(projectRef, { preferredName });

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
    overrides?: WorktreeSessionOverrides;
    selection?: WorktreeSessionSelection | null;
  }
): Promise<{ id: string; branch: string; path: string; selection: WorktreeSessionSelection } | null> {
  if (isCreatingWorktreeSession) {
    return null;
  }

  const configState = useConfigStore.getState();
  const selection = options?.selection === undefined
    ? resolveWorktreeSessionSelection(configState, options?.overrides)
    : options.selection;
  if (!selection || !isValidWorktreeSessionSelection(configState, selection)) {
    toast.error(formatMessage(
      useI18nStore.getState().dictionary,
      'session.newWorktree.error.noModelSelected',
    ));
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
        returnAfterDirectoryCreated: options?.returnAfterDirectoryCreated,
      });
      const createdMetadata = {
        ...metadata,
        createdFromBranch: options?.createdFromBranch || rootBranch || start,
        kind,
      };

      await waitForWorktreeBootstrapIfEnabled(projectRef, metadata.path);

      const sessionStore = useSessionUIStore.getState();
      const session = await sessionStore.createSession(undefined, metadata.path);
      if (!session) {
        await removeProjectWorktree(projectRef, metadata, { deleteLocalBranch: true }).catch(() => undefined);
        throw new Error('Could not create a session for the worktree.');
      }

      initializeSessionForWorktree(session.id, createdMetadata, options?.overrides, selection);

      return { id: session.id, branch: metadata.branch || base, path: metadata.path, selection };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create worktree session';
      toast.error('Failed to create worktree', { description: message });
      return null;
    }
  } finally {
    isCreatingWorktreeSession = false;
  }
}
