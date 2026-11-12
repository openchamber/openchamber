/**
 * VS Code Git API implementation
 * Uses bridge messages to communicate with the extension host
 */

import { BridgeRequestError, sendBridgeMessage, sendBridgeMessageWithOptions } from './bridge';
import { GIT_REPOSITORY_UNREADABLE, GitRepositoryUnreadableError } from '@openchamber/ui/lib/gitRepositoryUnreadable';
import { GitNetworkOperationRequestError } from '@openchamber/ui/lib/api/types';
import { gitIdentityProfilesSchema } from '@openchamber/ui/lib/api/git-identity';
import { readRepositoryContext, readRepositoryRemotes } from './git-remotes';
import type {
  GitAPI,
  GitStatus,
  GitBranch,
  GitDeleteBranchPayload,
  GitRemoveRemotePayload,
  GitWorktreeInfo,
  GitWorktreeBootstrapStatus,
  CreateGitWorktreePayload,
  GitWorktreeValidationResult,
  GitWorktreeCreateResult,
  RemoveGitWorktreePayload,
  TeardownGitWorktreePayload,
  GitWorktreeSnapshotPayload,
  GitWorktreeSnapshotResult,
  GitIdentityProfile,
  GitRemote,
  GitContributorDestinationCandidates,
  GitNetworkOperation,
  GitNetworkOperationError,
  GitNetworkOperationPlan,
  GitNetworkOperationRequest,
  GitNetworkOperationTarget,
  GitNetworkTransport,
  GitNetworkTransportMode,
} from '@openchamber/ui/lib/api/types';

const requestWorktreeBootstrapStatus = (directory: string): Promise<GitWorktreeBootstrapStatus> => {
  return sendBridgeMessage<GitWorktreeBootstrapStatus>('api:git/worktrees/bootstrap-status', { directory });
};

// No bridge timeout: the extension host runs the teardown commands first and
// gives them 5 minutes. Giving up in the webview would report a failure, put
// the sessions back, and then watch the host remove the worktree anyway.
const removeWorktreeThroughBridge = (directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }> => (
  sendBridgeMessageWithOptions<{ success: boolean }>('api:git/worktrees', {
    directory,
    method: 'DELETE',
    body: {
      directory: payload.directory,
      deleteLocalBranch: payload.deleteLocalBranch === true,
      teardownCommand: payload.teardownCommand,
    },
  }, { timeoutMs: 0 })
);

// Author profiles live in webview memory for the lifetime of the view, as they
// always have. Nothing applies them to a repository in this runtime, and the
// extension host stores nothing.
let storedProfiles: GitIdentityProfile[] = [];

const readStoredProfiles = (): GitIdentityProfile[] => storedProfiles;

const writeStoredProfiles = (profiles: GitIdentityProfile[]): void => {
  storedProfiles = gitIdentityProfilesSchema.parse(profiles);
};

// Network operations. Remote-branch deletion is the only one the VS Code
// surfaces mount; the webview maps its plan onto the standard remote-branches
// bridge message so system Git on the extension host performs it with the
// user's own credentials. Push, pull, fetch and sync have no bridge message.
const VSCODE_GIT_UNSUPPORTED_MESSAGE = 'Only remote branch deletion is supported as a Git network operation in the VS Code runtime';

const unsupportedNetworkOperation = async (): Promise<never> => {
  throw new GitNetworkOperationRequestError('RUNTIME_UNSUPPORTED', VSCODE_GIT_UNSUPPORTED_MESSAGE, 501);
};

const invalidNetworkRequest = (message: string): never => {
  throw new GitNetworkOperationRequestError('INVALID_REQUEST', message, 400);
};

const SYSTEM_TRANSPORT: GitNetworkTransport = {
  mode: 'system',
  verification: { status: 'unverified', reason: 'system-credentials' },
};
const RUNTIME_IDENTITY = { id: 'vscode-webview', platform: 'vscode', label: 'VS Code Extension' } as const;
const OPERATION_HISTORY_LIMIT = 100;

type CompatibilityNetworkRequest = Extract<GitNetworkOperationRequest, { operation: 'delete-remote-branch' }>;

type CompatibilityOperation = {
  request: CompatibilityNetworkRequest;
  snapshot: GitNetworkOperation;
  execution: Promise<GitNetworkOperation> | null;
};

type CompatibilityBridgePayload = {
  directory: string;
  remote: string;
  branch?: string;
};

type StepOutcome = { ok: true } | { ok: false; message: string };

const operations = new Map<string, CompatibilityOperation>();

const isTerminal = (state: GitNetworkOperation['state']): boolean => state !== 'planned' && state !== 'running';

const pruneOperations = (): void => {
  for (const [operationId, entry] of operations) {
    if (operations.size <= OPERATION_HISTORY_LIMIT) return;
    if (isTerminal(entry.snapshot.state)) operations.delete(operationId);
  }
};

const requireOperation = (operationId: string): CompatibilityOperation => {
  const entry = operations.get(operationId);
  if (!entry) throw new GitNetworkOperationRequestError('NOT_FOUND', 'Git network operation not found', 404);
  return entry;
};

const requireSystemTransport = (mode: GitNetworkTransportMode): void => {
  if (mode !== 'system') invalidNetworkRequest('VS Code Git transport is limited to system Git credentials');
};

const headBranch = (ref: string): string => {
  const match = /^refs\/heads\/(.+)$/.exec(ref);
  return match ? match[1] : invalidNetworkRequest(`Unsupported Git ref: ${ref}`);
};

const buildTarget = (request: CompatibilityNetworkRequest): GitNetworkOperationTarget => {
  requireSystemTransport(request.transportMode);
  headBranch(request.destinationRef);
  return {
    operation: 'delete-remote-branch',
    repositoryId: request.repositoryId,
    bindingRevision: request.bindingRevision,
    configRevision: request.configRevision,
    remote: request.remote,
    destinationRef: request.destinationRef,
  };
};

const snapshotBase = (snapshot: GitNetworkOperation) => ({
  operationId: snapshot.operationId,
  runtimeIdentity: snapshot.runtimeIdentity,
  transport: snapshot.transport,
  target: snapshot.target,
});

// A transfer has no bridge timeout: once Git is running on the extension host,
// giving up in the webview would report a failure Git may still turn into a
// success, and would let another operation start beside it. The operation
// stays `running` until the host answers.
const runBridgeStep = async (type: string, payload: CompatibilityBridgePayload): Promise<StepOutcome> => {
  try {
    const result = await sendBridgeMessageWithOptions<{ success?: boolean } | undefined>(type, payload, { timeoutMs: 0 });
    return result?.success === false ? { ok: false, message: 'Git command reported failure' } : { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

const transportFailure = (message: string): GitNetworkOperationError<'TRANSPORT_FAILED'> => ({ code: 'TRANSPORT_FAILED', message });

// The bridge messages address remotes by name, so Git uses whatever URL the
// remote has at execution time. Before anything runs, the remotes are read
// again and must still match the plan; a changed remote ends the operation as
// conflicted instead of transferring against an endpoint nobody approved.
const revalidatePlannedRemotes = async (request: CompatibilityNetworkRequest): Promise<GitNetworkOperationError<'STALE_REPOSITORY' | 'STALE_CONFIG' | 'REMOTE_CHANGED'> | null> => {
  const current = await readRepositoryContext(request.directory);
  if (current.repositoryId !== request.repositoryId) {
    return { code: 'STALE_REPOSITORY', message: 'The repository changed since this operation was planned' };
  }
  const remote = current.remotes.find((candidate) => candidate.name === request.remote.name);
  if (!remote || remote.push.fingerprint !== request.remote.endpoint.fingerprint) {
    return { code: 'REMOTE_CHANGED', message: `Remote ${request.remote.name} changed since this operation was planned` };
  }
  if (current.configRevision !== request.configRevision) {
    return { code: 'STALE_CONFIG', message: 'Remote configuration changed since this operation was planned' };
  }
  return null;
};

const runCompatibilityOperation = async (entry: CompatibilityOperation): Promise<GitNetworkOperation> => {
  const { request } = entry;
  const base = snapshotBase(entry.snapshot);
  const directory = request.directory;

  let stale: Awaited<ReturnType<typeof revalidatePlannedRemotes>>;
  try {
    stale = await revalidatePlannedRemotes(request);
  } catch (error) {
    return {
      ...base, state: 'failed', completedSteps: [],
      error: { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) },
    };
  }
  if (stale) return { ...base, state: 'conflicted', completedSteps: [], error: stale };

  const outcome = await runBridgeStep('api:git/remote-branches', {
    directory, remote: request.remote.name, branch: headBranch(request.destinationRef),
  });

  if (!outcome.ok) {
    return { ...base, state: 'failed', completedSteps: ['validated'], error: transportFailure(outcome.message) };
  }
  return {
    ...base,
    state: 'succeeded',
    completedSteps: ['validated', 'transferred'],
  };
};

export const createVSCodeGitAPI = (): GitAPI => ({
  checkIsGitRepository: async (directory: string): Promise<boolean> => {
    try {
      return await sendBridgeMessage<boolean>('api:git/check', { directory });
    } catch (error) {
      // The extension's probe names a Git that could not answer with this code.
      if (error instanceof BridgeRequestError && error.code === GIT_REPOSITORY_UNREADABLE) {
        throw new GitRepositoryUnreadableError(error.message);
      }
      throw error;
    }
  },

  getGitStatus: async (directory: string, options?: { mode?: 'light'; fresh?: boolean }): Promise<GitStatus> => {
    return sendBridgeMessage<GitStatus>('api:git/status', { directory, mode: options?.mode });
  },

  revertGitFile: async (directory: string, filePath: string, options?: { scope?: 'all' | 'working' }): Promise<void> => {
    await sendBridgeMessage('api:git/revert', { directory, path: filePath, scope: options?.scope });
  },

  stageGitFile: async (directory: string, filePath: string): Promise<void> => {
    await sendBridgeMessage('api:git/stage', { directory, path: filePath });
  },

  stageGitFiles: async (directory: string, filePaths: string[]): Promise<void> => {
    await sendBridgeMessage('api:git/stage', { directory, paths: filePaths });
  },

  unstageGitFile: async (directory: string, filePath: string): Promise<void> => {
    await sendBridgeMessage('api:git/unstage', { directory, path: filePath });
  },

  unstageGitFiles: async (directory: string, filePaths: string[]): Promise<void> => {
    await sendBridgeMessage('api:git/unstage', { directory, paths: filePaths });
  },

  stageGitHunk: async (directory: string, filePath: string, patch: string): Promise<void> => {
    await sendBridgeMessage('api:git/apply-hunk', { directory, path: filePath, patch, action: 'stage' });
  },

  unstageGitHunk: async (directory: string, filePath: string, patch: string): Promise<void> => {
    await sendBridgeMessage('api:git/apply-hunk', { directory, path: filePath, patch, action: 'unstage' });
  },

  revertGitHunk: async (directory: string, filePath: string, patch: string): Promise<void> => {
    await sendBridgeMessage('api:git/apply-hunk', { directory, path: filePath, patch, action: 'discard' });
  },

  isLinkedWorktree: async (directory: string): Promise<boolean> => {
    return sendBridgeMessage<boolean>('api:git/worktree-type', { directory });
  },

  getGitBranches: async (directory: string): Promise<GitBranch> => {
    return sendBridgeMessage<GitBranch>('api:git/branches', { directory, method: 'GET' });
  },

  getGitUnpushedBranchCounts: async (directory: string, branches: string[]) => {
    return sendBridgeMessage('api:git/branch-push-status', { directory, branches });
  },

  deleteGitBranch: async (directory: string, payload: GitDeleteBranchPayload): Promise<{ success: boolean }> => {
    return sendBridgeMessage<{ success: boolean }>('api:git/branches', {
      directory,
      method: 'DELETE',
      name: payload.branch,
      force: payload.force,
    });
  },


  removeRemote: async (directory: string, payload: GitRemoveRemotePayload): Promise<{ success: boolean }> => {
    return sendBridgeMessage<{ success: boolean }>('api:git/remotes', {
      directory,
      method: 'DELETE',
      remote: payload.remote,
    });
  },

  listGitWorktrees: async (directory: string): Promise<GitWorktreeInfo[]> => {
    return sendBridgeMessage<GitWorktreeInfo[]>('api:git/worktrees', { directory, method: 'GET' });
  },

  validateGitWorktree: async (directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult> => {
    if (payload.changeRequestSource || payload.ensureRemoteUrl) return unsupportedNetworkOperation();
    return sendBridgeMessage<GitWorktreeValidationResult>('api:git/worktrees/validate', {
      directory,
      ...(payload || {}),
    });
  },

  getGitWorktreeBootstrapStatus: async (directory: string): Promise<GitWorktreeBootstrapStatus> => {
    return requestWorktreeBootstrapStatus(directory);
  },

  previewGitWorktree: async (directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> => {
    if (payload.changeRequestSource || payload.ensureRemoteUrl) return unsupportedNetworkOperation();
    return sendBridgeMessage<GitWorktreeCreateResult>('api:git/worktrees/preview', {
      directory,
      method: 'POST',
      ...(payload || {}),
    });
  },

  createGitWorktree: async (directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> => {
    if (payload.changeRequestSource || payload.ensureRemoteUrl) return unsupportedNetworkOperation();
    return sendBridgeMessage<GitWorktreeCreateResult>('api:git/worktrees', {
      directory,
      method: 'POST',
      ...(payload || {}),
    });
  },

  deleteGitWorktree: async (directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }> => removeWorktreeThroughBridge(directory, payload),

  planNetworkOperation: async (request: GitNetworkOperationRequest): Promise<GitNetworkOperationPlan> => {
    if (request.operation !== 'delete-remote-branch') return unsupportedNetworkOperation();
    if (!request.directory.trim()) invalidNetworkRequest('Directory is required');
    const target = buildTarget(request);
    const plan: GitNetworkOperationPlan = {
      operationId: crypto.randomUUID(),
      runtimeIdentity: RUNTIME_IDENTITY,
      transport: SYSTEM_TRANSPORT,
      target,
      completedSteps: [],
      state: 'planned',
    };
    operations.set(plan.operationId, { request, snapshot: plan, execution: null });
    pruneOperations();
    return plan;
  },

  executeNetworkOperation: async (operationId: string): Promise<GitNetworkOperation> => {
    const entry = requireOperation(operationId);
    if (entry.execution) return entry.execution;
    if (entry.snapshot.state !== 'planned') return entry.snapshot;
    entry.snapshot = { ...snapshotBase(entry.snapshot), completedSteps: ['validated'], state: 'running' };
    entry.execution = runCompatibilityOperation(entry).then((snapshot) => {
      entry.snapshot = snapshot;
      entry.execution = null;
      return snapshot;
    });
    return entry.execution;
  },

  getNetworkOperation: async (operationId: string): Promise<GitNetworkOperation> => requireOperation(operationId).snapshot,

  cancelNetworkOperation: async (operationId: string): Promise<GitNetworkOperation> => {
    const entry = requireOperation(operationId);
    if (entry.snapshot.state === 'planned') {
      entry.snapshot = {
        ...snapshotBase(entry.snapshot),
        completedSteps: [],
        state: 'cancelled',
        error: { code: 'CANCELLED', message: 'Git network operation was cancelled before it started' },
      };
    }
    return entry.snapshot;
  },

  listContributorDestinations: async (): Promise<GitContributorDestinationCandidates> => ({ kind: 'ordinary' }),
  issueContributorDestination: unsupportedNetworkOperation,
  inspectCheckoutTrust: unsupportedNetworkOperation,
  decideCheckoutTrust: unsupportedNetworkOperation,

  listGitStashes: async (directory: string) => sendBridgeMessage('api:git/stashes', { directory }),
  countGitStashFiles: async (directory: string, refs: string[]) => sendBridgeMessage('api:git/stashes/file-counts', { directory, refs }),
  stashGitChanges: async (directory: string, options?: { message?: string }) => sendBridgeMessage('api:git/stash', { directory, message: options?.message }),
  applyGitStash: async (directory: string, options: { ref: string }) => sendBridgeMessage('api:git/stash/apply', { directory, ref: options.ref }),
  popGitStash: async (directory: string, options: { ref: string }) => sendBridgeMessage('api:git/stash/pop', { directory, ref: options.ref }),
  dropGitStash: async (directory: string, options: { ref: string }) => sendBridgeMessage('api:git/stash/drop', { directory, ref: options.ref }),

  createBranch: async (directory: string, name: string, startPoint?: string): Promise<{ success: boolean; branch: string }> => {
    return sendBridgeMessage<{ success: boolean; branch: string }>('api:git/branches', {
      directory,
      method: 'POST',
      name,
      startPoint,
    });
  },

  renameBranch: async (directory: string, oldName: string, newName: string): Promise<{ success: boolean; branch: string }> => {
    return sendBridgeMessage<{ success: boolean; branch: string }>('api:git/branches/rename', {
      directory,
      method: 'PUT',
      oldName,
      newName,
    });
  },

  getGitIdentities: async (): Promise<GitIdentityProfile[]> => readStoredProfiles(),

  createGitIdentity: async (profile: GitIdentityProfile): Promise<GitIdentityProfile> => {
    writeStoredProfiles([...readStoredProfiles().filter((entry) => entry.id !== profile.id), profile]);
    return profile;
  },

  updateGitIdentity: async (id: string, profile: GitIdentityProfile): Promise<GitIdentityProfile> => {
    if (profile.id !== id) throw new Error('Git identity profile ID does not match the update target');
    writeStoredProfiles(readStoredProfiles().map((entry) => (entry.id === id ? profile : entry)));
    return profile;
  },

  deleteGitIdentity: async (id: string): Promise<void> => {
    writeStoredProfiles(readStoredProfiles().filter((entry) => entry.id !== id));
  },

  getRemotes: async (directory: string): Promise<GitRemote[]> => readRepositoryRemotes(directory),

  stash: async (
    directory: string,
    options?: { message?: string; includeUntracked?: boolean }
  ): Promise<{ success: boolean }> => {
    return sendBridgeMessage<{ success: boolean }>('api:git/stash', {
      directory,
      ...options,
    });
  },

  stashPop: async (directory: string): Promise<{ success: boolean }> => {
    return sendBridgeMessage<{ success: boolean }>('api:git/stash/pop', { directory });
  },

  resolveRepositoryPrefix: async (directory: string): Promise<string> => {
    return sendBridgeMessage<string>('api:git/repository-prefix', { directory });
  },

  validateWorktreeDirectory: async (directory: string, worktreeRoot: string): Promise<{
    valid: boolean;
    insideWorktreeRoot: boolean;
    resolvedWorktreeRoot: string | null;
    resolvedCwd: string | null;
  }> => {
    return sendBridgeMessage<{
      valid: boolean;
      insideWorktreeRoot: boolean;
      resolvedWorktreeRoot: string | null;
      resolvedCwd: string | null;
    }>('api:git/validate-directory', { directory, worktreeRoot });
  },

  canonicalizeWorktreeState: async (directory: string): Promise<{
    worktreeRoot: string | null;
    cwd: string | null;
    branch: string | null;
    headState: 'branch' | 'detached' | 'unborn';
    worktreeStatus: 'ready' | 'missing' | 'invalid' | 'not-a-repo';
    legacy: boolean;
    degraded: boolean;
    attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
  }> => {
    return sendBridgeMessage<{
      worktreeRoot: string | null;
      cwd: string | null;
      branch: string | null;
      headState: 'branch' | 'detached' | 'unborn';
      worktreeStatus: 'ready' | 'missing' | 'invalid' | 'not-a-repo';
      legacy: boolean;
      degraded: boolean;
      attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
    }>('api:git/canonicalize-worktree-state', { directory });
  },

  worktree: {
    list: async (directory: string): Promise<GitWorktreeInfo[]> => {
      return sendBridgeMessage<GitWorktreeInfo[]>('api:git/worktrees', { directory, method: 'GET' });
    },
    validate: async (directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult> => {
      return sendBridgeMessage<GitWorktreeValidationResult>('api:git/worktrees/validate', {
        directory,
        ...(payload || {}),
      });
    },
    bootstrapStatus: async (directory: string): Promise<GitWorktreeBootstrapStatus> => {
      return requestWorktreeBootstrapStatus(directory);
    },
    preview: async (directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> => {
      return sendBridgeMessage<GitWorktreeCreateResult>('api:git/worktrees/preview', {
        directory,
        method: 'POST',
        ...(payload || {}),
      });
    },
    create: async (directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> => {
      return sendBridgeMessage<GitWorktreeCreateResult>('api:git/worktrees', {
        directory,
        method: 'POST',
        ...(payload || {}),
      });
    },
    remove: async (directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }> => removeWorktreeThroughBridge(directory, payload),
    teardown: async (directory: string, payload: TeardownGitWorktreePayload): Promise<{ success: boolean }> => (
      sendBridgeMessageWithOptions<{ success: boolean }>('api:git/worktrees/teardown', {
        directory,
        worktreeDirectory: payload.directory,
        teardownCommand: payload.teardownCommand,
      }, { timeoutMs: 0 })
    ),
    snapshot: async (directory: string, payload: GitWorktreeSnapshotPayload): Promise<GitWorktreeSnapshotResult> => {
      return sendBridgeMessage<GitWorktreeSnapshotResult>('api:git/worktrees/snapshot', { directory, ref: payload.ref });
    },
  },
});
