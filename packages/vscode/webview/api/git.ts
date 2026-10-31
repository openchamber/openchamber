/**
 * VS Code Git API implementation
 * Uses bridge messages to communicate with the extension host
 */

import { sendBridgeMessage, sendBridgeMessageWithOptions } from './bridge';
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
  GitNetworkSyncStepResult,
} from '@openchamber/ui/lib/api/types';

const requestWorktreeBootstrapStatus = (directory: string): Promise<GitWorktreeBootstrapStatus> => {
  return sendBridgeMessage<GitWorktreeBootstrapStatus>('api:git/worktrees/bootstrap-status', { directory });
};

// Author profiles live in webview memory for the lifetime of the view, as they
// always have. The extension host applies a profile to a repository through the
// standard identity bridge message and stores nothing itself.
let storedProfiles: GitIdentityProfile[] = [];

const readStoredProfiles = (): GitIdentityProfile[] => storedProfiles;

const writeStoredProfiles = (profiles: GitIdentityProfile[]): void => {
  storedProfiles = gitIdentityProfilesSchema.parse(profiles);
};

// Network operations. The shared Git surfaces plan and execute push, pull,
// fetch, sync and remote-branch deletion through the operation lifecycle. The
// webview maps each plan onto the standard Git bridge messages so system Git on
// the extension host performs the transfer with the user's own credentials.
const VSCODE_GIT_UNSUPPORTED_MESSAGE = 'Contributor, clone and checkout hydration Git operations are not supported in the VS Code runtime';

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

type CompatibilityNetworkRequest = Exclude<GitNetworkOperationRequest, { operation: 'clone' | 'checkout-hydration' }>;

type CompatibilityOperation = {
  request: CompatibilityNetworkRequest;
  snapshot: GitNetworkOperation;
  execution: Promise<GitNetworkOperation> | null;
};

type CompatibilityBridgePayload = {
  directory: string;
  remote: string;
  branch?: string;
  options?: string[];
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
  const authority = {
    repositoryId: request.repositoryId,
    bindingRevision: request.bindingRevision,
    configRevision: request.configRevision,
  };
  switch (request.operation) {
    case 'push': {
      requireSystemTransport(request.transportMode);
      headBranch(request.sourceRef);
      headBranch(request.destinationRef);
      const target: Extract<GitNetworkOperationTarget, { operation: 'push' }> = {
        operation: 'push', ...authority, remote: request.remote,
        sourceRef: request.sourceRef, destinationRef: request.destinationRef,
      };
      if (request.forceWithLease) target.forceWithLease = request.forceWithLease;
      if (request.configureUpstream !== undefined) target.configureUpstream = request.configureUpstream;
      return target;
    }
    case 'fetch': {
      requireSystemTransport(request.transportMode);
      if (request.fetchScope === 'remote') {
        return { operation: 'fetch', fetchScope: 'remote', ...authority, remote: request.remote, force: false };
      }
      headBranch(request.sourceRef);
      const target: Extract<GitNetworkOperationTarget, { operation: 'fetch'; fetchScope?: 'ref' }> = {
        operation: 'fetch', ...authority, remote: request.remote,
        sourceRef: request.sourceRef, destinationRef: request.destinationRef,
      };
      if (request.fetchScope) target.fetchScope = request.fetchScope;
      return target;
    }
    case 'pull':
      requireSystemTransport(request.transportMode);
      headBranch(request.sourceRef);
      return {
        operation: 'pull', ...authority, remote: request.remote,
        sourceRef: request.sourceRef, destinationRef: request.destinationRef,
      };
    case 'delete-remote-branch':
      requireSystemTransport(request.transportMode);
      headBranch(request.destinationRef);
      return { operation: 'delete-remote-branch', ...authority, remote: request.remote, destinationRef: request.destinationRef };
    case 'sync': {
      requireSystemTransport(request.fetch.transportMode);
      requireSystemTransport(request.push.transportMode);
      headBranch(request.fetch.sourceRef);
      headBranch(request.push.sourceRef);
      headBranch(request.push.destinationRef);
      const target: Extract<GitNetworkOperationTarget, { operation: 'sync' }> = {
        operation: 'sync', ...authority,
        fetch: { ...request.fetch.remote, sourceRef: request.fetch.sourceRef, destinationRef: request.fetch.destinationRef },
        pull: { destinationRef: request.pull.destinationRef },
        push: { ...request.push.remote, sourceRef: request.push.sourceRef, destinationRef: request.push.destinationRef },
      };
      if (request.push.forceWithLease) target.push.forceWithLease = request.push.forceWithLease;
      return target;
    }
  }
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

const pushPayload = (
  directory: string,
  remote: string,
  sourceRef: string,
  destinationRef: string,
  options: { forceWithLease?: { expectedRemoteSha: string }; configureUpstream?: boolean },
): CompatibilityBridgePayload => {
  const source = headBranch(sourceRef);
  const destination = headBranch(destinationRef);
  const gitOptions: string[] = [];
  if (options.configureUpstream) gitOptions.push('--set-upstream');
  if (options.forceWithLease) gitOptions.push(`--force-with-lease=${destination}:${options.forceWithLease.expectedRemoteSha}`);
  return {
    directory,
    remote,
    branch: source === destination ? source : `${source}:${destination}`,
    options: gitOptions,
  };
};

const plannedEndpoints = (request: CompatibilityNetworkRequest): Array<{ name: string; side: 'fetch' | 'push'; fingerprint: string }> => {
  switch (request.operation) {
    case 'sync':
      return [
        { name: request.fetch.remote.name, side: 'fetch', fingerprint: request.fetch.remote.endpoint.fingerprint },
        { name: request.push.remote.name, side: 'push', fingerprint: request.push.remote.endpoint.fingerprint },
      ];
    case 'fetch':
    case 'pull':
      return [{ name: request.remote.name, side: 'fetch', fingerprint: request.remote.endpoint.fingerprint }];
    case 'push':
    case 'delete-remote-branch':
      return [{ name: request.remote.name, side: 'push', fingerprint: request.remote.endpoint.fingerprint }];
  }
};

// The bridge messages address remotes by name, so Git uses whatever URL the
// remote has at execution time. Before anything runs, the remotes are read
// again and must still match the plan; a changed remote ends the operation as
// conflicted instead of transferring against an endpoint nobody approved.
const revalidatePlannedRemotes = async (request: CompatibilityNetworkRequest): Promise<GitNetworkOperationError<'STALE_REPOSITORY' | 'STALE_CONFIG' | 'REMOTE_CHANGED'> | null> => {
  const current = await readRepositoryContext(request.directory);
  if (current.repositoryId !== request.repositoryId) {
    return { code: 'STALE_REPOSITORY', message: 'The repository changed since this operation was planned' };
  }
  for (const planned of plannedEndpoints(request)) {
    const remote = current.remotes.find((candidate) => candidate.name === planned.name);
    if (!remote || remote[planned.side].fingerprint !== planned.fingerprint) {
      return { code: 'REMOTE_CHANGED', message: `Remote ${planned.name} changed since this operation was planned` };
    }
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

  if (request.operation === 'sync') {
    const stepResults: GitNetworkSyncStepResult[] = [];
    const steps: Array<{ step: GitNetworkSyncStepResult['step']; run: () => Promise<StepOutcome> }> = [
      { step: 'fetch', run: () => runBridgeStep('api:git/fetch', {
        directory, remote: request.fetch.remote.name, branch: headBranch(request.fetch.sourceRef),
      }) },
      { step: 'pull', run: () => runBridgeStep('api:git/pull', {
        directory, remote: request.fetch.remote.name, branch: headBranch(request.fetch.sourceRef),
      }) },
      { step: 'push', run: () => runBridgeStep('api:git/push', pushPayload(
        directory, request.push.remote.name, request.push.sourceRef, request.push.destinationRef,
        { forceWithLease: request.push.forceWithLease },
      )) },
    ];
    let failure: GitNetworkOperationError<'TRANSPORT_FAILED'> | null = null;
    for (const { step, run } of steps) {
      if (failure) {
        stepResults.push({ step, status: 'skipped' });
        continue;
      }
      const outcome = await run();
      if (outcome.ok) {
        stepResults.push({ step, status: 'succeeded' });
      } else {
        failure = transportFailure(outcome.message);
        stepResults.push({ step, status: 'failed', error: failure });
      }
    }
    if (!failure) {
      return { ...base, state: 'succeeded', completedSteps: ['validated', 'transferred', 'updated-local-repository'], stepResults };
    }
    const anySucceeded = stepResults.some((result) => result.status === 'succeeded');
    return {
      ...base,
      state: anySucceeded ? 'partial' : 'failed',
      completedSteps: anySucceeded ? ['validated', 'transferred'] : ['validated'],
      stepResults,
      error: failure,
    };
  }

  let outcome: StepOutcome;
  if (request.operation === 'push') {
    outcome = await runBridgeStep('api:git/push', pushPayload(
      directory, request.remote.name, request.sourceRef, request.destinationRef,
      { forceWithLease: request.forceWithLease, configureUpstream: request.configureUpstream },
    ));
  } else if (request.operation === 'fetch') {
    outcome = await runBridgeStep('api:git/fetch', request.fetchScope === 'remote'
      ? { directory, remote: request.remote.name }
      : { directory, remote: request.remote.name, branch: headBranch(request.sourceRef) });
  } else if (request.operation === 'pull') {
    outcome = await runBridgeStep('api:git/pull', {
      directory, remote: request.remote.name, branch: headBranch(request.sourceRef),
    });
  } else {
    outcome = await runBridgeStep('api:git/remote-branches', {
      directory, remote: request.remote.name, branch: headBranch(request.destinationRef),
    });
  }

  if (!outcome.ok) {
    return { ...base, state: 'failed', completedSteps: ['validated'], error: transportFailure(outcome.message) };
  }
  return {
    ...base,
    state: 'succeeded',
    completedSteps: request.operation === 'fetch' || request.operation === 'pull'
      ? ['validated', 'transferred', 'updated-local-repository']
      : ['validated', 'transferred'],
  };
};

export const createVSCodeGitAPI = (): GitAPI => ({
  checkIsGitRepository: async (directory: string): Promise<boolean> => {
    return sendBridgeMessage<boolean>('api:git/check', { directory });
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

  deleteGitWorktree: async (directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }> => {
    return sendBridgeMessage<{ success: boolean }>('api:git/worktrees', {
      directory,
      method: 'DELETE',
      body: {
        directory: payload.directory,
        deleteLocalBranch: payload.deleteLocalBranch === true,
      },
    });
  },

  planNetworkOperation: async (request: GitNetworkOperationRequest): Promise<GitNetworkOperationPlan> => {
    if (request.operation === 'clone' || request.operation === 'checkout-hydration') return unsupportedNetworkOperation();
    if (!request.directory.trim()) invalidNetworkRequest('Directory is required');
    const target = buildTarget(request);
    const plan: GitNetworkOperationPlan = {
      operationId: crypto.randomUUID(),
      runtimeIdentity: RUNTIME_IDENTITY,
      transport: request.operation === 'sync' ? { fetch: SYSTEM_TRANSPORT, push: SYSTEM_TRANSPORT } : SYSTEM_TRANSPORT,
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
    remove: async (directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }> => {
      return sendBridgeMessage<{ success: boolean }>('api:git/worktrees', {
        directory,
        method: 'DELETE',
        body: {
          directory: payload.directory,
          deleteLocalBranch: payload.deleteLocalBranch === true,
        },
      });
    },
    snapshot: async (directory: string, payload: GitWorktreeSnapshotPayload): Promise<GitWorktreeSnapshotResult> => {
      return sendBridgeMessage<GitWorktreeSnapshotResult>('api:git/worktrees/snapshot', { directory, ref: payload.ref });
    },
  },
});
