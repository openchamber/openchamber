import { normalizeGitRemoteEndpoint } from './credential-resolver.js';
import { createWithPlannedRemote, hydrateFollowingPlannedRemotes } from './planned-remotes.js';
import { forkRemoteName } from './contributor-remote.js';
import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';
import { asNonEmptyString } from '../shared/guards.js';
import { fingerprintRemoteUrl, redactRemoteUrl } from '../source-control/url-redaction.js';
import type { SourceControlChangeRequestSource } from '@openchamber/sdk';
import type { BindingRead } from '../source-control/binding-service-contracts.js';
import type { ProviderReadContext } from '../source-control/provider-contract.js';
import type { GitRouteDependencies } from './routes.js';
import type { RepositoryAuthority, SourceRequest } from './network-execution-contracts.js';
import type { PlannedRemote, WorktreeCreateInput, WorktreeServerOptions } from './service-contracts.js';

type HydrateCheckoutInput = Parameters<NonNullable<WorktreeServerOptions['hydrateCheckout']>>[0];

export interface WorktreeCreationInput extends WorktreeCreateInput {
  changeRequestSource?: SourceRequest | null | undefined;
  taskTitle?: unknown;
  generatedBranchName?: unknown;
  generatedBranchPrefix?: unknown;
}

type ResolvedChangeRequestSource = SourceControlChangeRequestSource & {
  context: ProviderReadContext;
  requestedRemoteName: string;
  remoteUrl?: string;
};
type GitLibraries = Pick<typeof import('./index.js'), 'getRepositoryRemoteUrls' | 'validateWorktreeCreate'
  | 'createWorktree' | 'markGeneratedBranchName' | 'seedBranchTaskTitle'>;
type OptionalDependency<Key extends keyof GitRouteDependencies> = GitRouteDependencies[Key];
interface WorktreeCreationOptions {
  getGitLibraries(): Promise<GitLibraries>;
  networkOperations: OptionalDependency<'networkOperations'>;
  getSourceControlBinding: ((directory: string, plannedRemote?: PlannedRemote) => Promise<BindingRead>) | undefined;
  contributorProvenance: OptionalDependency<'contributorProvenance'>;
  resolveChangeRequestSource: ((input: SourceRequest) => Promise<ResolvedChangeRequestSource>) | undefined;
  createHttpsCredentialReference: OptionalDependency<'createHttpsCredentialReference'>;
  resolveSourceControlAccount: OptionalDependency<'resolveSourceControlAccount'>;
  worktreeBootstrapStore: OptionalDependency<'worktreeBootstrapStore'>;
  disposeInstance?: WorktreeServerOptions['disposeInstance'];
}

export class WorktreeCreationError extends Error {
  declare status: number;
  declare code: string | undefined;
  declare remoteName?: unknown;

  constructor(message: string, status: number, code?: string, details: { remoteName?: unknown } = {}) {
    super(message);
    this.name = 'WorktreeCreationError';
    this.status = status;
    this.code = code;
    Object.assign(this, details);
  }
}

export const hasClientContributorAuthority = (body: WorktreeCreationInput | null | undefined) => body?.contributorFork !== undefined
  || body?.changeRequestTransfer !== undefined || body?.contributorTransferComplete !== undefined
  || (body?.changeRequestSource && body?.ensureRemoteUrl !== undefined);

const CHANGE_REF_RE = /^refs\/changes\/(\d{2})\/([1-9]\d{0,9})\/[1-9]\d{0,5}$/;

const headBranchOf = (source: ResolvedChangeRequestSource) => {
  if (source.headRef.startsWith('refs/heads/')) return { name: source.headRef.slice('refs/heads/'.length), change: false };
  const change = CHANGE_REF_RE.exec(source.headRef);
  const changeHost = sourceControlProviderDescriptors.get(source.context?.provider)?.capabilities.createVia === 'push';
  const number = change?.[2];
  if (number === undefined || number.padStart(2, '0').slice(-2) !== change?.[1] || !changeHost || source.classification !== 'same-repository') {
    throw new WorktreeCreationError('Change request head is not a branch this repository can check out', 409, 'INVALID_REQUEST');
  }
  return { name: `change-${number}`, change: true };
};

const worktreeInputForSource = (input: WorktreeCreationInput, source: ResolvedChangeRequestSource) => {
  const result = {
    ...input,
    changeRequestSource: undefined,
    contributorFork: source.classification === 'contributor-fork',
    changeRequestTransfer: true,
    ensureRemoteName: source.requestedRemoteName,
    ensureRemoteUrl: source.remoteUrl ?? source.endpoint,
    expectedRevision: source.headSha,
  };
  const head = headBranchOf(source);
  if (head.change) result.branchName = head.name;
  return result;
};

const withoutSystemHttpsUsername = (remoteUrl: string | undefined, transportMode: string | undefined) => {
  if (transportMode !== 'system' || !remoteUrl) return remoteUrl;
  let parsed;
  try { parsed = new URL(remoteUrl); } catch { return remoteUrl; }
  if (parsed.protocol !== 'https:' || !parsed.username || parsed.password) return remoteUrl;
  parsed.username = '';
  return parsed.href;
};

const matchesGitHubHeadRemote = (source: ResolvedChangeRequestSource, transportMode: string | undefined) => {
  try {
    const remote = normalizeGitRemoteEndpoint(withoutSystemHttpsUsername(source.remoteUrl, transportMode));
    const head = normalizeGitRemoteEndpoint(source.endpoint);
    return remote.host === source.context.instance && remote.host === head.host
      && (remote.protocol === 'ssh' || (remote.protocol === 'https' && remote.port === head.port))
      && remote.path.replace(/\.git$/, '').toLowerCase() === head.path.replace(/\.git$/, '').toLowerCase();
  } catch {
    return false;
  }
};

const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const hasErrorFields = (value: unknown): value is { code?: unknown; remoteName?: unknown } =>
  value !== null && value !== undefined;

export const createWorktreeCreation = ({
  getGitLibraries,
  networkOperations,
  getSourceControlBinding,
  contributorProvenance,
  resolveChangeRequestSource,
  createHttpsCredentialReference,
  resolveSourceControlAccount,
  worktreeBootstrapStore,
  disposeInstance,
}: WorktreeCreationOptions) => {
  const changeRequestSourceOnRepository = async (directory: string, source: ResolvedChangeRequestSource): Promise<ResolvedChangeRequestSource> => {
    if (source.classification !== 'same-repository') {
      return source.sourceProject?.owner
        ? Object.freeze({ ...source, requestedRemoteName: forkRemoteName(source.sourceProject.owner) })
        : source;
    }
    const { getRepositoryRemoteUrls } = await getGitLibraries();
    const primary = (await getRepositoryRemoteUrls(directory)).find((remote) => remote.name === source.context.primaryRemote);
    if (!primary?.fetchUrl) return source;
    return Object.freeze({ ...source, requestedRemoteName: primary.name, remoteUrl: primary.fetchUrl });
  };

  const validationInput = async (directory: string, input: WorktreeCreationInput) => {
    if (!input.changeRequestSource) return input;
    if (!(resolveChangeRequestSource instanceof Function)) {
      throw new WorktreeCreationError('Contributor worktrees are unavailable', 501, 'RUNTIME_UNSUPPORTED');
    }
    const source = await changeRequestSourceOnRepository(directory, await resolveChangeRequestSource(input.changeRequestSource));
    return worktreeInputForSource(input, source);
  };

  const transferChangeRequestHead = async (directory: string, input: WorktreeCreationInput, sourceRequest: SourceRequest) => {
    const { validateWorktreeCreate } = await getGitLibraries();
    if (!(resolveChangeRequestSource instanceof Function)
      || !(createHttpsCredentialReference instanceof Function)
      || !(resolveSourceControlAccount instanceof Function)
      || !(networkOperations?.transferContributorHead instanceof Function)) {
      throw new WorktreeCreationError('Contributor worktrees are unavailable', 501, 'RUNTIME_UNSUPPORTED');
    }
    const source = await changeRequestSourceOnRepository(directory, await resolveChangeRequestSource(sourceRequest));
    const headBranch = headBranchOf(source).name;
    const destinationRef = `refs/remotes/${source.requestedRemoteName}/${headBranch}`;
    const transferInput = {
      ...worktreeInputForSource(input, source),
      existingBranch: destinationRef.slice('refs/'.length),
      setUpstream: false,
    };
    const validation = await validateWorktreeCreate(directory, transferInput);
    if (!validation.ok && !validation.errors.every((entry) => entry.code === 'contributor_transfer_unavailable')) {
      const collision = validation.errors.find((entry) => entry.code === 'remote_name_collision');
      if (collision) {
        throw new WorktreeCreationError(collision.message, 409, 'CONTRIBUTOR_REMOTE_COLLISION', { remoteName: transferInput.ensureRemoteName });
      }
      throw new WorktreeCreationError(
        validation.errors.map((entry) => entry.message).filter(Boolean).join('\n') || 'Failed to validate worktree creation',
        409,
        'INVALID_REQUEST',
      );
    }
    const descriptor = sourceControlProviderDescriptors.get(source.context.provider);
    const authMethods = descriptor?.authMethods;
    const cli = authMethods?.cli;
    const enterprisePrimary = source.context.provider === 'github'
      && source.classification === 'same-repository'
      && descriptor?.transport.managedHttpsInstances === 'default-only'
      && !descriptor.instance.defaultInstances.includes(source.context.instance);
    if (enterprisePrimary || (cli && cli.kind === 'service' && !authMethods.pat)) {
      if (source.classification !== 'same-repository') {
        throw new WorktreeCreationError('Service-login worktrees require a head in the primary remote repository', 501, 'RUNTIME_UNSUPPORTED');
      }
      if (!getSourceControlBinding) throw new TypeError('getSourceControlBinding is not a function');
      const { repository, binding } = await getSourceControlBinding(directory);
      const remote = source.context.primaryRemote;
      const transportMode = binding ? binding.remotes.find((entry) => entry.name === remote)?.mode : 'system';
      if (enterprisePrimary && !matchesGitHubHeadRemote(source, transportMode)) {
        throw new WorktreeCreationError('The primary remote must point to the GitHub Enterprise pull request head repository', 409, 'RUNTIME_UNSUPPORTED');
      }
      const planned = await networkOperations.plan({
        operation: 'fetch', directory,
        repositoryId: source.context.repositoryId,
        bindingRevision: source.context.bindingRevision,
        configRevision: repository.configRevision,
        remote: { name: remote, endpoint: {
          displayUrl: redactRemoteUrl(source.remoteUrl),
          fingerprint: fingerprintRemoteUrl(source.remoteUrl),
        } },
        transportMode,
        sourceRef: source.headRef, destinationRef,
      });
      const transfer = await networkOperations.execute(planned.operationId);
      if (transfer.state !== 'succeeded') {
        throw new WorktreeCreationError(transfer.error?.message || 'Change request head fetch failed', 409, transfer.error?.code || 'UNKNOWN');
      }
      await resolveChangeRequestSource(sourceRequest);
      return {
        source: { ...source, endpoint: source.remoteUrl },
        input: { ...transferInput, contributorTransferComplete: true },
      };
    }
    const account = await resolveSourceControlAccount(source.context);
    if (account?.credentialId !== source.context.accountId || account?.status !== 'valid'
      || !isSafeInteger(account?.credentialRevision) || account.credentialRevision < 1
      || Object.prototype.toString.call(account?.providerUserId) !== '[object String]' || !account.providerUserId) {
      throw new WorktreeCreationError('Contributor credential is unavailable', 409, 'AUTHENTICATION_REQUIRED');
    }
    const credentialId = createHttpsCredentialReference({
      provider: source.context.provider,
      instance: source.context.instance,
      credentialId: account.credentialId,
      credentialRevision: account.credentialRevision,
      providerUserId: account.providerUserId,
    });
    const transfer = await networkOperations.transferContributorHead({
      directory,
      sourceRequest,
      source,
      destinationRef,
      credentialId,
    });
    if (transfer.state !== 'succeeded') {
      throw new WorktreeCreationError(
        transfer.error?.message || 'Contributor head transfer failed',
        transfer.error?.code === 'AUTHENTICATION_REQUIRED' ? 401 : 409,
        transfer.error?.code || 'UNKNOWN',
      );
    }
    return { source, input: { ...transferInput, contributorTransferComplete: true } };
  };

  const create = async (directory: string, requestInput: WorktreeCreationInput | null | undefined) => {
    const { createWorktree, markGeneratedBranchName, seedBranchTaskTitle, validateWorktreeCreate } = await getGitLibraries();
    if (!(createWorktree instanceof Function) || !(validateWorktreeCreate instanceof Function)) {
      throw new WorktreeCreationError('Worktree creation is not available', 501);
    }
    if (hasClientContributorAuthority(requestInput)) {
      throw new WorktreeCreationError('Invalid contributor worktree request', 400, 'INVALID_CONTRIBUTOR_WORKTREE');
    }
    if (!(networkOperations?.hydrateBoundCheckout instanceof Function)
      || !(worktreeBootstrapStore?.read instanceof Function)
      || !(worktreeBootstrapStore?.write instanceof Function)) {
      throw new WorktreeCreationError('Worktree checkout bootstrap is not available', 501);
    }
    let input = requestInput || {};
    let source = null;
    if (input.changeRequestSource) {
      ({ source, input } = await transferChangeRequestHead(directory, input, input.changeRequestSource));
    }
    const hydrateWith = (repositoryAuthority: RepositoryAuthority | null, { directory: checkoutDirectory, parentRemoteName }: HydrateCheckoutInput) => networkOperations.hydrateBoundCheckout({
      directory: checkoutDirectory,
      parentRemoteName,
      parentEndpoint: source?.endpoint,
      repositoryAuthority,
    });
    const createWith = (hydrateCheckout: WorktreeServerOptions['hydrateCheckout']) => createWorktree(directory, input, {
      contributorProvenance,
      contributorSource: source,
      hydrateCheckout,
      bootstrapStore: worktreeBootstrapStore,
      disposeInstance,
    });
    try {
      const result = getSourceControlBinding instanceof Function
        ? await createWithPlannedRemote({
          directory,
          readBinding: getSourceControlBinding,
          serialize: input.contributorFork === true,
          remote: input.ensureRemoteName && input.ensureRemoteUrl
            ? { name: input.ensureRemoteName, url: input.ensureRemoteUrl }
            : undefined,
          create: (pinned) => createWith((checkout) => hydrateFollowingPlannedRemotes(pinned, (authority) => hydrateWith(authority, checkout))),
        })
        : await createWith((checkout) => hydrateWith(null, checkout));
      const taskTitle = asNonEmptyString(requestInput?.taskTitle);
      if (taskTitle && seedBranchTaskTitle instanceof Function) {
        await seedBranchTaskTitle(directory, result?.branch, taskTitle);
      }
      const generatedName = asNonEmptyString(requestInput?.generatedBranchName);
      if (generatedName && generatedName === result?.branch && markGeneratedBranchName instanceof Function) {
        await markGeneratedBranchName(directory, generatedName, asNonEmptyString(requestInput?.generatedBranchPrefix));
      }
      return result;
    } catch (error) {
      if (hasErrorFields(error) && error.code === 'CONTRIBUTOR_REMOTE_COLLISION') {
        throw new WorktreeCreationError('Contributor remote name is already used by a different endpoint', 409, 'CONTRIBUTOR_REMOTE_COLLISION', { remoteName: error.remoteName });
      }
      throw error;
    }
  };

  return { validationInput, create };
};
