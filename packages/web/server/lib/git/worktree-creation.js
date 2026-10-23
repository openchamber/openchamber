/**
 * Worktree creation with the server's authority checks, shared by
 * `POST /api/git/worktrees` (the New worktree dialog) and the session service
 * (`session.create` with a pull or merge request). One implementation, so a
 * worktree made from a change request is the same kind whichever way it was
 * asked for: the head is resolved and transferred here, never taken from the
 * caller, and a contributor fork gets its named remote, provenance and no
 * upstream.
 */
import { forkRemoteName } from './contributor-remote.js';
import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';
import { asNonEmptyString } from '../shared/guards.js';

/** A refusal with the HTTP status and body fields the route answers with. */
export class WorktreeCreationError extends Error {
  constructor(message, status, code, details = {}) {
    super(message);
    this.name = 'WorktreeCreationError';
    this.status = status;
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * Contributor authority is the server's to derive. A request carrying any of
 * these fields itself is refused before anything else happens.
 */
export const hasClientContributorAuthority = (body) => body?.contributorFork !== undefined
  || body?.changeRequestTransfer !== undefined || body?.contributorTransferComplete !== undefined
  || (body?.changeRequestSource && body?.ensureRemoteUrl !== undefined);

// A change host's revision ref, `refs/changes/<last two digits>/<change>/<revision>`.
const CHANGE_REF_RE = /^refs\/changes\/(\d{2})\/([1-9]\d{0,9})\/[1-9]\d{0,5}$/;

/**
 * The branch a change request's head is checked out on. A branch head keeps
 * its name. A change host's revision ref (Gerrit) has no branch, so the
 * worktree gets `change-<number>`; that ref is accepted only from the same
 * repository of a provider that creates changes by push, the gate the Git
 * planner applies to review refs.
 */
const headBranchOf = (source) => {
  if (source.headRef.startsWith('refs/heads/')) return { name: source.headRef.slice('refs/heads/'.length), change: false };
  const change = CHANGE_REF_RE.exec(source.headRef);
  const changeHost = sourceControlProviderDescriptors.get(source.context?.provider)?.capabilities.createVia === 'push';
  if (!change || change[2].padStart(2, '0').slice(-2) !== change[1] || !changeHost || source.classification !== 'same-repository') {
    throw new WorktreeCreationError('Change request head is not a branch this repository can check out', 409, 'INVALID_REQUEST');
  }
  return { name: `change-${change[2]}`, change: true };
};

// A change request from this repository itself is fetched onto the primary
// remote it already has, under that remote's own URL, so the checkout adds no
// second remote for the same project. Only a fork gets a remote of its own.
const worktreeInputForSource = (input, source) => {
  const result = {
    ...input,
    changeRequestSource: undefined,
    contributorFork: source.classification === 'contributor-fork',
    changeRequestTransfer: true,
    ensureRemoteName: source.requestedRemoteName,
    ensureRemoteUrl: source.remoteUrl ?? source.endpoint,
    expectedRevision: source.headSha,
  };
  // A change host's head names its own local branch.
  const head = headBranchOf(source);
  if (head.change) result.branchName = head.name;
  return result;
};

export const createWorktreeCreation = ({
  getGitLibraries,
  networkOperations,
  getSourceControlBinding,
  contributorProvenance,
  resolveChangeRequestSource,
  createHttpsCredentialReference,
  resolveSourceControlAccount,
  worktreeBootstrapStore,
}) => {
  const changeRequestSourceOnRepository = async (directory, source) => {
    if (source.classification !== 'same-repository') {
      // A fork's remote is named after its owner, which the provider just said;
      // the picker cannot always know it (GitLab lists merge requests without it).
      return source.sourceProject?.owner
        ? Object.freeze({ ...source, requestedRemoteName: forkRemoteName(source.sourceProject.owner) })
        : source;
    }
    const { getRepositoryRemoteUrls } = await getGitLibraries();
    const primary = (await getRepositoryRemoteUrls(directory)).find((remote) => remote.name === source.context.primaryRemote);
    if (!primary?.fetchUrl) return source;
    return Object.freeze({ ...source, requestedRemoteName: primary.name, remoteUrl: primary.fetchUrl });
  };

  /** The input `validateWorktreeCreate` checks: a change request becomes the server-resolved remote and head. */
  const validationInput = async (directory, input) => {
    if (!input.changeRequestSource) return input;
    if (!(resolveChangeRequestSource instanceof Function)) {
      throw new WorktreeCreationError('Contributor worktrees are unavailable', 501, 'RUNTIME_UNSUPPORTED');
    }
    const source = await changeRequestSourceOnRepository(directory, await resolveChangeRequestSource(input.changeRequestSource));
    return worktreeInputForSource(input, source);
  };

  /**
   * Resolves the change request, checks the account that will fetch it, and
   * transfers its head into the repository. Nothing is created on disk before
   * the transfer succeeds.
   */
  const transferChangeRequestHead = async (directory, input) => {
    const { validateWorktreeCreate } = await getGitLibraries();
    if (!(resolveChangeRequestSource instanceof Function)
      || !(createHttpsCredentialReference instanceof Function)
      || !(resolveSourceControlAccount instanceof Function)
      || !(networkOperations?.transferContributorHead instanceof Function)) {
      throw new WorktreeCreationError('Contributor worktrees are unavailable', 501, 'RUNTIME_UNSUPPORTED');
    }
    const source = await changeRequestSourceOnRepository(directory, await resolveChangeRequestSource(input.changeRequestSource));
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
    const account = await resolveSourceControlAccount(source.context);
    if (account?.credentialId !== source.context.accountId || account?.status !== 'valid'
      || !Number.isSafeInteger(account?.credentialRevision) || account.credentialRevision < 1
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
      sourceRequest: input.changeRequestSource,
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

  /** Creates a worktree; with `input.changeRequestSource`, from that change request's head. */
  const create = async (directory, requestInput) => {
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
      ({ source, input } = await transferChangeRequestHead(directory, input));
    }
    const bindingRead = getSourceControlBinding instanceof Function
      ? await getSourceControlBinding(directory)
      : null;
    // An unbound repository hydrates through the machine's own Git for every
    // remote, the same way it pushes; its authority is the unbound revision.
    const repositoryAuthority = bindingRead ? {
      repositoryId: bindingRead.repository.repositoryId,
      bindingRevision: bindingRead.revision,
      configRevision: bindingRead.repository.configRevision,
    } : null;
    const hydrateCheckout = ({ directory: checkoutDirectory, parentRemoteName }) => networkOperations.hydrateBoundCheckout({
      directory: checkoutDirectory,
      parentRemoteName,
      parentEndpoint: source?.endpoint,
      repositoryAuthority,
    });
    try {
      const result = await createWorktree(directory, input, {
        contributorProvenance,
        contributorSource: source,
        hydrateCheckout,
        bootstrapStore: worktreeBootstrapStore,
      });
      // Made for a pull request or an issue: its title names the task until
      // the agent names it (`seedBranchTaskTitle`).
      const taskTitle = asNonEmptyString(requestInput?.taskTitle);
      if (taskTitle && seedBranchTaskTitle instanceof Function) {
        await seedBranchTaskTitle(directory, result?.branch, taskTitle);
      }
      // The client says when it generated the branch's name; the agent may
      // then rename it after the task (`readRenameableGeneratedBranch`).
      const generatedName = asNonEmptyString(requestInput?.generatedBranchName);
      if (generatedName && generatedName === result?.branch && markGeneratedBranchName instanceof Function) {
        await markGeneratedBranchName(directory, generatedName);
      }
      return result;
    } catch (error) {
      if (error?.code === 'CONTRIBUTOR_REMOTE_COLLISION') {
        throw new WorktreeCreationError('Contributor remote name is already used by a different endpoint', 409, 'CONTRIBUTOR_REMOTE_COLLISION', { remoteName: error.remoteName });
      }
      throw error;
    }
  };

  return { validationInput, create };
};
