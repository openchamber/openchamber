import type {
  GitAPI,
  GitBranch,
  GitContributorDestinationCandidates,
  GitNetworkOperation,
  GitNetworkOperationPlan,
  GitNetworkOperationRequest,
  GitStatus,
  SourceControlAPI,
  SourceControlBindingRead,
  SourceControlIdentity,
} from '@/lib/api/types';
import { GitNetworkOperationRequestError } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { gitOperationRecoveryOwner } from '@/lib/source-control/git-operation-recovery';
import { notifyGitPush } from '@/lib/gitPushEvents';

type BoundGitNetworkAction = 'fetch' | 'pull' | 'sync';

export class BoundGitNetworkOperationError extends Error {
  readonly code:
    | 'binding-required'
    | 'anonymous-read-only'
    | 'binding-needs-attention'
    | 'branch-required'
    | 'publish-target-required'
    | 'publish-cancelled'
    | 'publish-selection-stale'
    | 'tracking-required'
    | 'tracking-remote-mismatch'
    | 'binding-remote-missing'
    | 'stale-runtime'
    | 'system-transport-declined'
    | 'contributor-publish-cancelled'
    | 'contributor-publish-cancelled-after-update'
    | 'operation-unavailable'
    | 'operation-result'
    | 'operation-storage'
    | 'invalid-terminal-state';

  constructor(code: BoundGitNetworkOperationError['code']) {
    super(code);
    this.name = 'BoundGitNetworkOperationError';
    this.code = code;
  }
}

const fail = (code: BoundGitNetworkOperationError['code']): never => {
  throw new BoundGitNetworkOperationError(code);
};

const requireRemoteReady = (read: SourceControlBindingRead, name: string) => {
  if (!read.binding) throw new BoundGitNetworkOperationError('binding-required');
  const grant = read.binding.remotes.find((remote) => remote.name === name);
  if (!grant) throw new BoundGitNetworkOperationError('binding-remote-missing');
  const remote = read.repository.remotes.find((remote) => remote.name === name);
  if (grant.readiness !== 'ready' || !remote || grant.fetch.fingerprint !== remote.fetch.fingerprint
    || grant.push.fingerprint !== remote.push.fingerprint) {
    throw new BoundGitNetworkOperationError('binding-needs-attention');
  }
  return grant;
};

const requireCurrentRuntime = (runtimeKey: () => string, capturedRuntime: string): void => {
  if (runtimeKey() !== capturedRuntime) fail('stale-runtime');
};

export type GitOperationRead = {
  runtimeKey: string;
  operation: GitNetworkOperation;
  availability: 'available' | 'unavailable';
};

export class GitOperationResultError extends BoundGitNetworkOperationError {
  constructor(readonly read: GitOperationRead, code: BoundGitNetworkOperationError['code'] = read.availability === 'unavailable' ? 'operation-unavailable' : 'operation-result') {
    super(code);
    this.name = 'GitOperationResultError';
    if (read.availability === 'available' && 'error' in read.operation) this.message = read.operation.error.message;
  }
}

export const isGitOperationUnresolved = (read: GitOperationRead): boolean => read.availability === 'unavailable'
  || read.operation.state === 'planned' || read.operation.state === 'running' || read.operation.state === 'outcome-unknown';

const acceptOperation = (read: GitOperationRead, operation: GitNetworkOperation, runtimeKey: () => string): GitOperationRead => {
  if (runtimeKey() !== read.runtimeKey || operation.runtimeIdentity.id !== read.operation.runtimeIdentity.id
    || operation.runtimeIdentity.platform !== read.operation.runtimeIdentity.platform) {
    throw new GitOperationResultError({ ...read, availability: 'unavailable' }, 'stale-runtime');
  }
  if (operation.operationId !== read.operation.operationId || JSON.stringify(operation.target) !== JSON.stringify(read.operation.target)) {
    throw new GitOperationResultError({ ...read, availability: 'unavailable' }, 'invalid-terminal-state');
  }
  if (read.operation.state !== 'planned' && read.operation.state !== 'running' && operation.state !== read.operation.state) {
    throw new GitOperationResultError({ ...read, availability: 'unavailable' }, 'invalid-terminal-state');
  }
  if (read.operation.completedSteps.some((step) => !operation.completedSteps.includes(step))
    || read.operation.stepResults?.some((step) => step.status === 'succeeded'
      && !operation.stepResults?.some((next) => next.step === step.step && next.status === 'succeeded'))) {
    throw new GitOperationResultError({ ...read, availability: 'unavailable' }, 'invalid-terminal-state');
  }
  if (operation.state === 'succeeded' && operation.target.operation === 'sync') {
    const steps = operation.stepResults;
    if (!steps || steps.length !== 3 || !['fetch', 'pull', 'push'].every((step) => steps.some((result) => result.step === step && result.status === 'succeeded'))) {
      throw new GitOperationResultError({ ...read, availability: 'unavailable' }, 'invalid-terminal-state');
    }
  }
  return { ...read, operation, availability: 'available' };
};

export const refreshGitOperation = async (
  git: Pick<GitAPI, 'getNetworkOperation' | 'cancelNetworkOperation'>,
  read: GitOperationRead,
  action: 'refresh' | 'cancel' = 'refresh',
  runtimeKey = getRuntimeKey,
  isCurrent: () => boolean = () => true,
): Promise<GitOperationRead> => {
  if (runtimeKey() !== read.runtimeKey || !isCurrent()) return { ...read, availability: 'unavailable' };
  if (action === 'cancel' && read.operation.state !== 'planned' && read.operation.state !== 'running') return read;
  let latest = read;
  try {
    if (action === 'cancel') {
      latest = acceptOperation(read, await git.getNetworkOperation(read.operation.operationId), runtimeKey);
      if (!isCurrent()) return { ...latest, availability: 'unavailable' };
      if (latest.operation.state !== 'planned' && latest.operation.state !== 'running') return latest;
      return acceptOperation(latest, await git.cancelNetworkOperation(read.operation.operationId), runtimeKey);
    }
    const operation = await git.getNetworkOperation(read.operation.operationId);
    if (!isCurrent()) return { ...read, availability: 'unavailable' };
    return acceptOperation(read, operation, runtimeKey);
  } catch {
    return { ...latest, availability: 'unavailable' };
  }
};

const executePlan = async (
  git: Pick<GitAPI, 'executeNetworkOperation' | 'getNetworkOperation'>,
  plan: GitNetworkOperationPlan,
  runtimeKey: () => string,
  capturedRuntime: string,
  onOperation?: (read: GitOperationRead) => void,
): Promise<Extract<GitNetworkOperation, { state: 'succeeded' }>> => {
  let read: GitOperationRead = { runtimeKey: capturedRuntime, operation: plan, availability: 'available' };
  onOperation?.(read);
  try { await gitOperationRecoveryOwner.remember(capturedRuntime, plan); } catch {
    throw new GitOperationResultError(read, 'operation-storage');
  }
  if (runtimeKey() !== capturedRuntime) throw new GitOperationResultError({ ...read, availability: 'unavailable' }, 'stale-runtime');
  try {
    read = acceptOperation(read, await git.executeNetworkOperation(plan.operationId), runtimeKey);
  } catch (error) {
    if (error instanceof GitOperationResultError) {
      onOperation?.(error.read);
      throw error;
    }
    read = { ...read, availability: 'unavailable' };
    // An execute response can be lost after remote acceptance. Only read the original ID, never plan or execute again.
    if (runtimeKey() === capturedRuntime) {
      try { read = acceptOperation(read, await git.getNetworkOperation(plan.operationId), runtimeKey); } catch { /* Keep the operation reference as unavailable. */ }
    }
  }
  onOperation?.(read);
  try { await gitOperationRecoveryOwner.complete(read, () => runtimeKey() === capturedRuntime); } catch {
    throw new GitOperationResultError(read, 'operation-storage');
  }
  if (read.availability === 'unavailable' || read.operation.state !== 'succeeded') throw new GitOperationResultError(read);
  return read.operation;
};

// Changes and walkthrough refresh a published pull request diff on this signal.
// The panel pushes through managed operations rather than the HTTP push adapter,
// so the managed paths announce too, keeping that adapter's contract: only a
// confirmed push, against the runtime captured before it started.
const announcePush = (directory: string, capturedRuntime: string) => notifyGitPush(directory, capturedRuntime);

type ConfirmSystemTransport = () => boolean | Promise<boolean>;

const planWithSystemAcknowledgement = async (
  git: Pick<GitAPI, 'planNetworkOperation'>,
  request: GitNetworkOperationRequest,
  confirmSystemTransport: ConfirmSystemTransport | undefined,
  runtimeKey: () => string,
  capturedRuntime: string,
  onOperation?: (read: GitOperationRead) => void,
): Promise<GitNetworkOperationPlan> => {
  let plan: GitNetworkOperationPlan;
  try {
    plan = await gitOperationRecoveryOwner.plan(git, request, capturedRuntime, () => runtimeKey() === capturedRuntime);
  } catch (error) {
    if (!(error instanceof GitNetworkOperationRequestError) || error.code !== 'ACKNOWLEDGEMENT_REQUIRED') throw error;
    if (request.operation !== 'push' && request.operation !== 'sync' && request.operation !== 'delete-remote-branch') throw error;
    const push = request.operation === 'sync' ? request.push : request;
    if (push.transportMode !== 'system' || !confirmSystemTransport) throw error;
    const accepted = await confirmSystemTransport();
    requireCurrentRuntime(runtimeKey, capturedRuntime);
    if (!accepted) fail('system-transport-declined');
    const acknowledgedRequest: GitNetworkOperationRequest = request.operation === 'sync'
      ? { ...request, push: { ...request.push, acknowledgeSystemTransport: true } }
      : { ...request, acknowledgeSystemTransport: true };
    plan = await gitOperationRecoveryOwner.plan(git, acknowledgedRequest, capturedRuntime, () => runtimeKey() === capturedRuntime);
  }
  onOperation?.({ runtimeKey: capturedRuntime, operation: plan, availability: 'available' });
  return plan;
};

export const runBoundRemoteBranchDelete = async ({
  branch,
  confirmSystemTransport,
  directory,
  git,
  remoteName,
  runtimeKey = getRuntimeKey,
  sourceControl,
}: {
  branch: string;
  confirmSystemTransport?: ConfirmSystemTransport;
  directory: string;
  git: Pick<GitAPI, 'planNetworkOperation' | 'executeNetworkOperation' | 'getNetworkOperation'>;
  remoteName: string;
  runtimeKey?: () => string;
  sourceControl: Pick<SourceControlAPI, 'repositoryBinding'>;
}): Promise<GitNetworkOperation> => {
  const capturedRuntime = runtimeKey();
  const bindingRead = await sourceControl.repositoryBinding(directory);
  requireCurrentRuntime(runtimeKey, capturedRuntime);
  if (bindingRead.status === 'missing') fail('binding-required');
  const binding = bindingRead.binding;
  if (!binding) throw new BoundGitNetworkOperationError('binding-required');
  const remote = requireRemoteReady(bindingRead, remoteName.trim());
  if (remote.mode === 'anonymous') fail('anonymous-read-only');
  const branchName = branch.trim().replace(/^refs\/heads\//, '');
  if (!branchName || branchName === 'HEAD') fail('branch-required');
  const request: GitNetworkOperationRequest = {
    operation: 'delete-remote-branch',
    directory,
    repositoryId: binding.repositoryId,
    bindingRevision: binding.revision,
    configRevision: bindingRead.repository.configRevision,
    remote: { name: remote.name, endpoint: remote.push },
    destinationRef: `refs/heads/${branchName}`,
    transportMode: remote.mode,
  };
  const plan = await planWithSystemAcknowledgement(
    git, request, confirmSystemTransport, runtimeKey, capturedRuntime,
  );
  requireCurrentRuntime(runtimeKey, capturedRuntime);
  const completion = await executePlan(git, plan, runtimeKey, capturedRuntime);
  return completion;
};

export const runGitClone = async ({
  destinationPath,
  git,
  gitIdentityId,
  remoteUrl,
  providerAccount,
  selection,
  signal,
  runtimeKey = getRuntimeKey,
  onOperation,
}: {
  destinationPath: string;
  git: Pick<GitAPI, 'planNetworkOperation' | 'executeNetworkOperation' | 'getNetworkOperation' | 'cancelNetworkOperation'>;
  gitIdentityId?: string;
  remoteUrl: string;
  providerAccount?: SourceControlIdentity & { accountId: string };
  selection: Pick<Extract<GitNetworkOperationRequest, { operation: 'clone'; transportMode: 'system' }>, 'transportMode' | 'unverifiedConfirmed'>
    | Pick<Extract<GitNetworkOperationRequest, { operation: 'clone'; credentialAccount: SourceControlIdentity & { accountId: string } }>, 'transportMode' | 'credentialAccount'>
    | { transportMode: 'managed'; sshCredentialId: string; credentialAccount?: never }
    | { transportMode: 'anonymous' };
  signal?: AbortSignal;
  runtimeKey?: () => string;
  onOperation?: (read: GitOperationRead) => void;
}): Promise<{ status: 'succeeded' | 'setup-required' | 'cancelled' }> => {
  const capturedRuntime = runtimeKey();
  if (signal?.aborted) return { status: 'cancelled' };
  if (!selection || (selection.transportMode === 'system' && selection.unverifiedConfirmed !== true)
    || (selection.transportMode === 'managed' && !selection.credentialAccount && !('sshCredentialId' in selection && selection.sshCredentialId))) fail('binding-required');
  const request: GitNetworkOperationRequest = {
    operation: 'clone',
    remoteUrl,
    destinationPath,
    ...selection,
  };
  if (gitIdentityId) request.gitIdentityId = gitIdentityId;
  if (providerAccount) request.providerAccount = providerAccount;
  const plan = await gitOperationRecoveryOwner.plan(git, request, capturedRuntime, () => runtimeKey() === capturedRuntime);
  onOperation?.({ runtimeKey: capturedRuntime, operation: plan, availability: 'available' });
  requireCurrentRuntime(runtimeKey, capturedRuntime);
  const cancel = () => {
    if (runtimeKey() === capturedRuntime) void git.cancelNetworkOperation(plan.operationId).catch(() => {});
  };
  if (signal?.aborted) {
    const cancelled = await git.cancelNetworkOperation(plan.operationId);
    const read: GitOperationRead = { runtimeKey: capturedRuntime, operation: cancelled, availability: 'available' };
    onOperation?.(read);
    await gitOperationRecoveryOwner.complete(read, () => runtimeKey() === capturedRuntime);
    return { status: 'cancelled' };
  }
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    await executePlan(git, plan, runtimeKey, capturedRuntime, onOperation);
    return { status: 'succeeded' };
  } catch (error) {
    if (error instanceof GitOperationResultError && error.read.availability === 'available') {
      const result = error.read.operation;
      if (result.state === 'partial' && result.target.operation === 'clone' && result.completedSteps.includes('checked-out')) {
        return { status: 'setup-required' };
      }
      if (result.state === 'cancelled') return { status: 'cancelled' };
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
};

export const runCheckoutHydration = async ({
  directory,
  git,
  parentRemoteName,
  runtimeKey = getRuntimeKey,
  sourceControl,
  onOperation,
}: {
  directory: string;
  git: Pick<GitAPI, 'planNetworkOperation' | 'executeNetworkOperation' | 'getNetworkOperation'>;
  parentRemoteName: string;
  runtimeKey?: () => string;
  sourceControl: Pick<SourceControlAPI, 'repositoryBinding'>;
  onOperation?: (read: GitOperationRead) => void;
}): Promise<GitNetworkOperation> => {
  const capturedRuntime = runtimeKey();
  const bindingRead = await sourceControl.repositoryBinding(directory);
  requireCurrentRuntime(runtimeKey, capturedRuntime);
  const binding = bindingRead.binding;
  if (!binding) throw new BoundGitNetworkOperationError('binding-required');
  const grant = requireRemoteReady(bindingRead, parentRemoteName.trim());
  const request: GitNetworkOperationRequest = {
    operation: 'checkout-hydration',
    directory,
    repositoryId: binding.repositoryId,
    bindingRevision: binding.revision,
    configRevision: bindingRead.repository.configRevision,
    remote: { name: grant.name, endpoint: grant.fetch },
  };
  const plan = await gitOperationRecoveryOwner.plan(
    git, request, capturedRuntime, () => runtimeKey() === capturedRuntime,
  );
  onOperation?.({ runtimeKey: capturedRuntime, operation: plan, availability: 'available' });
  requireCurrentRuntime(runtimeKey, capturedRuntime);
  return executePlan(git, plan, runtimeKey, capturedRuntime, onOperation);
};

type ContributorDestinations = Exclude<GitContributorDestinationCandidates, { kind: 'ordinary' }>;

const requireContributorDestinations = (
  value: GitContributorDestinationCandidates,
  code: BoundGitNetworkOperationError['code'],
): ContributorDestinations => {
  if (value.kind !== 'contributor') throw new BoundGitNetworkOperationError(code);
  return value;
};

export const buildBoundGitNetworkOperationRequest = ({
  action,
  bindingRead,
  directory,
  fetchTarget,
  remoteName,
  status,
  targets,
}: {
  action: BoundGitNetworkAction;
  bindingRead: SourceControlBindingRead;
  directory: string;
  fetchTarget?: GitFetchTarget;
  remoteName: string;
  status: GitStatus;
  targets?: GitPublishTargets;
}): GitNetworkOperationRequest => {
  if (bindingRead.status === 'missing') throw new BoundGitNetworkOperationError('binding-required');
  const binding = bindingRead.binding;

  if (action === 'fetch') {
    const selectedRemote = remoteName.trim();
    const remote = requireRemoteReady(bindingRead, selectedRemote);
    if (fetchTarget) {
      if (fetchTarget.remoteName.trim() !== selectedRemote) fail('tracking-remote-mismatch');
      const branch = requireHeadRef(fetchTarget.sourceRef);
      if (fetchTarget.destinationRef !== `refs/remotes/${selectedRemote}/${branch}`) fail('branch-required');
      return {
        operation: 'fetch',
        fetchScope: 'ref',
        directory,
        repositoryId: binding.repositoryId,
        bindingRevision: binding.revision,
        configRevision: bindingRead.repository.configRevision,
        remote: { name: remote.name, endpoint: remote.fetch },
        sourceRef: fetchTarget.sourceRef,
        destinationRef: fetchTarget.destinationRef,
        transportMode: remote.mode,
      };
    }
    return {
      operation: 'fetch',
      fetchScope: 'remote',
      directory,
      repositoryId: binding.repositoryId,
      bindingRevision: binding.revision,
      configRevision: bindingRead.repository.configRevision,
      remote: { name: remote.name, endpoint: remote.fetch },
      transportMode: remote.mode,
    };
  }

  const branch = status.current.trim();
  if (!branch || branch === 'HEAD') fail('branch-required');

  if (action === 'sync') {
    if (!targets?.fetch) throw new BoundGitNetworkOperationError('publish-target-required');
    const fetchRemote = requireRemoteReady(bindingRead, targets.fetch.remoteName);
    const pushRemote = requireRemoteReady(bindingRead, targets.push.remoteName);
    if (pushRemote.mode === 'anonymous') fail('anonymous-read-only');
    const fetchBranch = requireHeadRef(targets.fetch.ref);
    requireHeadRef(targets.push.ref);
    return {
      operation: 'sync', directory, repositoryId: binding.repositoryId,
      bindingRevision: binding.revision, configRevision: bindingRead.repository.configRevision,
      fetch: {
        remote: { name: fetchRemote.name, endpoint: fetchRemote.fetch },
        sourceRef: targets.fetch.ref, destinationRef: `refs/remotes/${fetchRemote.name}/${fetchBranch}`,
        transportMode: fetchRemote.mode,
      },
      pull: { destinationRef: `refs/heads/${branch}` },
      push: {
        remote: { name: pushRemote.name, endpoint: pushRemote.push },
        sourceRef: `refs/heads/${branch}`, destinationRef: targets.push.ref,
        transportMode: pushRemote.mode,
      },
    };
  }

  const selectedRemote = remoteName.trim();
  const trackingPrefix = `${selectedRemote}/`;
  const tracking = status.tracking?.trim();
  if (!tracking) throw new BoundGitNetworkOperationError('tracking-required');
  if (!selectedRemote || !tracking.startsWith(trackingPrefix)) {
    throw new BoundGitNetworkOperationError('tracking-remote-mismatch');
  }

  const trackedBranch = tracking.slice(trackingPrefix.length);
  if (!trackedBranch) fail('tracking-required');

  const boundRemote = requireRemoteReady(bindingRead, selectedRemote);

  const repository = {
    directory,
    repositoryId: binding.repositoryId,
    bindingRevision: binding.revision,
    configRevision: bindingRead.repository.configRevision,
  };
  return {
    operation: 'pull',
    ...repository,
    remote: { name: boundRemote.name, endpoint: boundRemote.fetch },
    sourceRef: `refs/heads/${trackedBranch}`,
    destinationRef: `refs/heads/${branch}`,
    transportMode: boundRemote.mode,
  };
};

export const buildBoundBranchPushRequest = ({
  bindingRead,
  branch,
  directory,
  remoteName,
  destinationRef,
  configureUpstream = false,
}: {
  bindingRead: SourceControlBindingRead;
  branch: string;
  directory: string;
  remoteName: string;
  destinationRef: string;
  configureUpstream?: boolean;
}): GitNetworkOperationRequest => {
  if (bindingRead.status === 'missing') fail('binding-required');
  const binding = bindingRead.binding;
  if (!binding) throw new BoundGitNetworkOperationError('binding-required');
  const localBranch = branch.trim();
  if (!localBranch || localBranch === 'HEAD') fail('branch-required');
  requireHeadRef(destinationRef);
  const selectedRemote = remoteName.trim();
  const boundRemote = requireRemoteReady(bindingRead, selectedRemote);
  if (boundRemote.mode === 'anonymous') fail('anonymous-read-only');
  return {
    operation: 'push',
    directory,
    repositoryId: binding.repositoryId,
    bindingRevision: binding.revision,
    configRevision: bindingRead.repository.configRevision,
    remote: { name: boundRemote.name, endpoint: boundRemote.push },
    sourceRef: `refs/heads/${localBranch}`,
    destinationRef,
    transportMode: boundRemote.mode,
    configureUpstream,
  };
};

export type GitPublishTargets = {
  push: { remoteName: string; ref: string };
  fetch?: { remoteName: string; ref: string };
};

export type GitFetchTarget = {
  remoteName: string;
  sourceRef: string;
  destinationRef: string;
};

export type GitPublishContext = {
  action: 'push' | 'sync';
  directory: string;
  runtime: string;
  bindingRead: Exclude<SourceControlBindingRead, { status: 'missing' }>;
  status: GitStatus;
  branches: GitBranch;
};

export type GitPublishSelection = GitPublishContext & { targets: GitPublishTargets };

const requireHeadRef = (ref: string): string => {
  if (!ref.startsWith('refs/heads/') || !ref.slice(11) || ref.slice(11) === 'HEAD') {
    throw new BoundGitNetworkOperationError('branch-required');
  }
  return ref.slice(11);
};

export const readGitPublishContext = async ({
  action, directory, git, sourceControl, runtimeKey = getRuntimeKey,
}: {
  action: 'push' | 'sync';
  directory: string;
  git: Pick<GitAPI, 'getGitStatus' | 'getGitBranches'>;
  sourceControl: Pick<SourceControlAPI, 'repositoryBinding'>;
  runtimeKey?: () => string;
}): Promise<GitPublishContext> => {
  const runtime = runtimeKey();
  const [bindingRead, status, branches] = await Promise.all([
    sourceControl.repositoryBinding(directory), git.getGitStatus(directory), git.getGitBranches(directory),
  ]);
  requireCurrentRuntime(runtimeKey, runtime);
  if (bindingRead.status === 'missing') throw new BoundGitNetworkOperationError('binding-required');
  if (!bindingRead.binding.remotes.some((remote) => remote.readiness === 'ready')) {
    throw new BoundGitNetworkOperationError('binding-needs-attention');
  }
  if (!bindingRead.binding.remotes.some((remote) => remote.readiness === 'ready' && remote.mode !== 'anonymous')) fail('anonymous-read-only');
  if (!status.current || status.current === 'HEAD') throw new BoundGitNetworkOperationError('branch-required');
  if (status.current !== branches.current) throw new BoundGitNetworkOperationError('publish-selection-stale');
  return { action, directory, runtime, bindingRead, status, branches };
};

export const validateGitPublishSelection = async ({
  selection, git, sourceControl, runtimeKey = getRuntimeKey, allowNewCommit = false,
}: {
  selection: GitPublishSelection;
  git: Pick<GitAPI, 'getGitStatus' | 'getGitBranches'>;
  sourceControl: Pick<SourceControlAPI, 'repositoryBinding'>;
  runtimeKey?: () => string;
  allowNewCommit?: boolean;
}): Promise<GitPublishContext> => {
  requireCurrentRuntime(runtimeKey, selection.runtime);
  const current = await readGitPublishContext({ ...selection, git, sourceControl, runtimeKey });
  const previousBinding = selection.bindingRead.binding;
  const binding = current.bindingRead.binding;
  if (current.status.current !== selection.status.current
    || current.status.tracking !== selection.status.tracking
    || binding.repositoryId !== previousBinding.repositoryId
    || binding.revision !== previousBinding.revision
    || binding.configRevision !== previousBinding.configRevision
    || JSON.stringify(binding.remotes) !== JSON.stringify(previousBinding.remotes)
    || (!allowNewCommit && current.branches.branches[current.status.current]?.commit
      !== selection.branches.branches[selection.status.current]?.commit)) {
    throw new BoundGitNetworkOperationError('publish-selection-stale');
  }
  return current;
};

export const prepareGitPublish = async ({
  choose, ...dependencies
}: Parameters<typeof readGitPublishContext>[0] & {
  choose: (context: GitPublishContext) => Promise<GitPublishTargets | null>;
}): Promise<GitPublishSelection> => {
  const context = await readGitPublishContext(dependencies);
  const targets = await choose(context);
  requireCurrentRuntime(dependencies.runtimeKey ?? getRuntimeKey, context.runtime);
  if (!targets) throw new BoundGitNetworkOperationError('publish-cancelled');
  const selection = { ...context, targets };
  await validateGitPublishSelection({ ...dependencies, selection });
  if (context.action === 'sync') {
    buildBoundGitNetworkOperationRequest({ ...context, action: 'sync', remoteName: '', targets });
  } else {
    buildBoundBranchPushRequest({
      ...context, branch: context.status.current, remoteName: targets.push.remoteName, destinationRef: targets.push.ref,
    });
  }
  return selection;
};

export const runPreparedGitPublish = async ({
  selection, git, sourceControl, runtimeKey = getRuntimeKey, confirmSystemTransport, allowNewCommit = false, assertCurrent, onOperation,
}: BoundGitNetworkDependencies & {
  selection: GitPublishSelection;
  git: Pick<GitAPI, 'getGitStatus' | 'getGitBranches' | 'planNetworkOperation' | 'executeNetworkOperation' | 'getNetworkOperation'>;
  allowNewCommit?: boolean;
  assertCurrent?: () => void;
}): Promise<GitNetworkOperation> => {
  const current = await validateGitPublishSelection({ selection, git, sourceControl, runtimeKey, allowNewCommit });
  assertCurrent?.();
  const request = selection.action === 'sync'
    ? buildBoundGitNetworkOperationRequest({ ...current, action: 'sync', remoteName: '', targets: selection.targets })
    : buildBoundBranchPushRequest({
      ...current, branch: current.status.current, remoteName: selection.targets.push.remoteName,
      destinationRef: selection.targets.push.ref, configureUpstream: !current.status.tracking,
    });
  const plan = await planWithSystemAcknowledgement(git, request, confirmSystemTransport, runtimeKey, selection.runtime, onOperation);
  requireCurrentRuntime(runtimeKey, selection.runtime);
  assertCurrent?.();
  const completion = await executePlan(git, plan, runtimeKey, selection.runtime, onOperation);
  if (completion.target.operation !== selection.action) throw new BoundGitNetworkOperationError('invalid-terminal-state');
  if (selection.action === 'sync') interpretGitNetworkTerminalOperation(completion, 'sync');
  announcePush(selection.directory, selection.runtime);
  return completion;
};

type GitNetworkTerminalInterpretation =
  | { status: 'succeeded' }
  | { status: 'failed'; state: Exclude<GitNetworkOperation['state'], 'planned' | 'running' | 'succeeded'>; message: string };

export const interpretGitNetworkTerminalOperation = (
  operation: GitNetworkOperation,
  action: BoundGitNetworkAction,
): GitNetworkTerminalInterpretation => {
  if (operation.state === 'planned' || operation.state === 'running') {
    throw new BoundGitNetworkOperationError('invalid-terminal-state');
  }
  if (operation.target.operation !== action) throw new BoundGitNetworkOperationError('invalid-terminal-state');
  if (operation.state !== 'succeeded') {
    return { status: 'failed', state: operation.state, message: operation.error.message };
  }
  if (action === 'sync') {
    const steps = operation.stepResults;
    if (!steps || steps.length !== 3 || steps.some((step) => step.status !== 'succeeded')) {
      fail('invalid-terminal-state');
    }
  }
  return { status: 'succeeded' };
};

type BoundGitNetworkDependencies = {
  sourceControl: Pick<SourceControlAPI, 'repositoryBinding'>;
  git: Pick<GitAPI, 'planNetworkOperation' | 'executeNetworkOperation' | 'getNetworkOperation'>;
  onOperation?: (read: GitOperationRead) => void;
  runtimeKey?: () => string;
  confirmSystemTransport?: ConfirmSystemTransport;
};

export const runBoundGitNetworkOperation = async ({
  action,
  directory,
  fetchTarget,
  remoteName,
  status,
  sourceControl,
  git,
  runtimeKey = getRuntimeKey,
  confirmSystemTransport,
  targets,
  onOperation,
}: {
  action: BoundGitNetworkAction;
  directory: string;
  fetchTarget?: GitFetchTarget;
  remoteName: string;
  status: GitStatus;
  targets?: GitPublishTargets;
} & BoundGitNetworkDependencies): Promise<GitNetworkOperation> => {
  const capturedRuntime = runtimeKey();
  const bindingRead = await sourceControl.repositoryBinding(directory);
  requireCurrentRuntime(runtimeKey, capturedRuntime);

  const request = buildBoundGitNetworkOperationRequest({ action, bindingRead, directory, fetchTarget, remoteName, status, targets });
  const plan = await planWithSystemAcknowledgement(
    git, request, confirmSystemTransport, runtimeKey, capturedRuntime, onOperation,
  );
  requireCurrentRuntime(runtimeKey, capturedRuntime);

  const completion = await executePlan(git, plan, runtimeKey, capturedRuntime, onOperation);
  interpretGitNetworkTerminalOperation(completion, action);
  if (action === 'sync') announcePush(directory, capturedRuntime);
  return completion;
};

export const runContributorPush = async ({
  directory,
  status,
  sourceControl,
  git,
  choose,
  destinations: initialDestinations,
  updatedBeforePublish = false,
  runtimeKey = getRuntimeKey,
  onOperation,
}: {
  directory: string;
  status: GitStatus;
  sourceControl: Pick<SourceControlAPI, 'repositoryBinding'>;
  git: Pick<GitAPI, 'listContributorDestinations' | 'issueContributorDestination' | 'planNetworkOperation' | 'executeNetworkOperation' | 'getNetworkOperation'>;
  onOperation?: (read: GitOperationRead) => void;
  choose: (candidates: ContributorDestinations['candidates']) => string | null | Promise<string | null>;
  destinations?: ContributorDestinations;
  updatedBeforePublish?: boolean;
  runtimeKey?: () => string;
}): Promise<GitNetworkOperation> => {
  const capturedRuntime = runtimeKey();
  const branch = status.current.trim();
  if (!branch || branch === 'HEAD') fail('branch-required');
  const [bindingRead, listedDestinations] = await Promise.all([
    sourceControl.repositoryBinding(directory), initialDestinations ?? git.listContributorDestinations(directory),
  ]);
  requireCurrentRuntime(runtimeKey, capturedRuntime);
  if (bindingRead.status === 'missing') fail('binding-required');
  const destinations = requireContributorDestinations(listedDestinations, 'binding-required');
  const selectedName = await choose(destinations.candidates);
  requireCurrentRuntime(runtimeKey, capturedRuntime);
  if (selectedName === null) {
    fail(updatedBeforePublish ? 'contributor-publish-cancelled-after-update' : 'contributor-publish-cancelled');
  }
  const candidate = destinations.candidates.find((entry) => entry.remote.name === selectedName);
  if (!candidate) throw new BoundGitNetworkOperationError('binding-remote-missing');
  requireRemoteReady(bindingRead, candidate.remote.name);
  const sourceRef = `refs/heads/${branch}`;
  const destinationRef = `refs/heads/${branch}`;
  const selection = await git.issueContributorDestination({
    directory,
    repositoryId: destinations.repositoryId,
    bindingRevision: destinations.bindingRevision,
    configRevision: destinations.configRevision,
    provenanceRevision: destinations.provenanceRevision,
    remote: candidate.remote,
    sourceRef,
    destinationRef,
    transportMode: 'managed',
  });
  requireCurrentRuntime(runtimeKey, capturedRuntime);
  const plan = await gitOperationRecoveryOwner.plan(git, {
    operation: 'push', directory,
    repositoryId: destinations.repositoryId,
    bindingRevision: destinations.bindingRevision,
    configRevision: destinations.configRevision,
    remote: candidate.remote,
    sourceRef,
    destinationRef,
    transportMode: 'managed',
    destinationSelectionId: selection.selectionId,
  }, capturedRuntime, () => runtimeKey() === capturedRuntime);
  onOperation?.({ runtimeKey: capturedRuntime, operation: plan, availability: 'available' });
  requireCurrentRuntime(runtimeKey, capturedRuntime);
  const completion = await executePlan(git, plan, runtimeKey, capturedRuntime, onOperation);
  announcePush(directory, capturedRuntime);
  return completion;
};

export const runContributorAwareSync = async ({
  directory,
  remoteName,
  status,
  sourceControl,
  git,
  choose,
  runtimeKey = getRuntimeKey,
  confirmSystemTransport,
  targets,
  onOperation,
}: {
  directory: string;
  remoteName: string;
  status: GitStatus;
  sourceControl: Pick<SourceControlAPI, 'repositoryBinding'>;
  git: Pick<GitAPI, 'listContributorDestinations' | 'issueContributorDestination' | 'planNetworkOperation' | 'executeNetworkOperation' | 'getNetworkOperation'>;
  onOperation?: (read: GitOperationRead) => void;
  choose: (candidates: ContributorDestinations['candidates']) => string | null | Promise<string | null>;
  runtimeKey?: () => string;
  confirmSystemTransport?: ConfirmSystemTransport;
  targets?: GitPublishTargets;
}): Promise<GitNetworkOperation> => {
  const capturedRuntime = runtimeKey();
  let destinations = await git.listContributorDestinations(directory);
  requireCurrentRuntime(runtimeKey, capturedRuntime);
  if (destinations.kind === 'ordinary') {
    return runBoundGitNetworkOperation({
      action: 'sync', directory, remoteName, status, sourceControl, git, runtimeKey,
      confirmSystemTransport, targets, onOperation,
    });
  }

  const updateRequired = status.behind > 0;
  if (updateRequired) {
    await runBoundGitNetworkOperation({
      action: 'pull', directory, remoteName, status, sourceControl, git, runtimeKey,
      confirmSystemTransport, onOperation,
    });
    requireCurrentRuntime(runtimeKey, capturedRuntime);
    destinations = await git.listContributorDestinations(directory);
    requireCurrentRuntime(runtimeKey, capturedRuntime);
  }
  const contributorDestinations = requireContributorDestinations(destinations, 'stale-runtime');

  return runContributorPush({
    directory,
    status,
    sourceControl,
    git,
    choose,
    destinations: contributorDestinations,
    updatedBeforePublish: updateRequired,
    runtimeKey,
    onOperation,
  });
};

export const runContributorAwarePush = async ({
  directory,
  branch,
  remoteName,
  sourceControl,
  git,
  choose,
  runtimeKey = getRuntimeKey,
  confirmSystemTransport,
  destinationRef,
  onOperation,
}: {
  directory: string;
  branch: string;
  remoteName: string;
  sourceControl: Pick<SourceControlAPI, 'repositoryBinding'>;
  git: Pick<GitAPI, 'listContributorDestinations' | 'issueContributorDestination' | 'planNetworkOperation' | 'executeNetworkOperation' | 'getNetworkOperation'>;
  onOperation?: (read: GitOperationRead) => void;
  choose: (candidates: ContributorDestinations['candidates']) => string | null | Promise<string | null>;
  runtimeKey?: () => string;
  confirmSystemTransport?: ConfirmSystemTransport;
  destinationRef?: string;
}): Promise<void> => {
  const capturedRuntime = runtimeKey();
  const destinations = await git.listContributorDestinations(directory);
  requireCurrentRuntime(runtimeKey, capturedRuntime);
  if (destinations.kind === 'ordinary') {
    if (!destinationRef) throw new BoundGitNetworkOperationError('publish-target-required');
    const bindingRead = await sourceControl.repositoryBinding(directory);
    requireCurrentRuntime(runtimeKey, capturedRuntime);
    const request = buildBoundBranchPushRequest({ bindingRead, branch, directory, remoteName, destinationRef, configureUpstream: true });
    const plan = await planWithSystemAcknowledgement(
      git, request, confirmSystemTransport, runtimeKey, capturedRuntime, onOperation,
    );
    requireCurrentRuntime(runtimeKey, capturedRuntime);
    await executePlan(git, plan, runtimeKey, capturedRuntime, onOperation);
    announcePush(directory, capturedRuntime);
    return;
  }
  await runContributorPush({
    directory,
    status: { current: branch, tracking: null, ahead: 0, behind: 0, files: [], isClean: true },
    sourceControl,
    git,
    choose,
    destinations,
    runtimeKey,
    onOperation,
  });
};
