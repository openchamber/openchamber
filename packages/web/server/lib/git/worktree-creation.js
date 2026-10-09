/**
 * Worktree creation with the server's authority checks, shared by
 * `POST /api/git/worktrees` (the New worktree dialog) and the session service
 * (`session.create` with a pull or merge request). One implementation, so a
 * worktree made from a change request is the same kind whichever way it was
 * asked for: the head is resolved and transferred here, never taken from the
 * caller, and a contributor fork gets its named remote, provenance and no
 * upstream.
 */

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

// A change request from this repository itself is fetched onto the primary
// remote it already has, under that remote's own URL, so the checkout adds no
// second remote for the same project. Only a fork gets a remote of its own.
// A fork's remote is named after its owner, which the provider just said; the
// picker cannot always know it (GitLab lists merge requests without it).
const forkRemoteName = (owner) => `pr-${String(owner || '').trim().toLowerCase()
  .replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'head'}`;

const worktreeInputForSource = (input, source) => ({
  ...input,
  changeRequestSource: undefined,
  contributorFork: source.classification === 'contributor-fork',
  changeRequestTransfer: true,
  ensureRemoteName: source.requestedRemoteName,
  ensureRemoteUrl: source.remoteUrl ?? source.endpoint,
  expectedRevision: source.headSha,
});

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
    const headBranch = source.headRef.slice('refs/heads/'.length);
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
    const { createWorktree, validateWorktreeCreate } = await getGitLibraries();
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
    const repositoryAuthority = bindingRead?.binding ? {
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
      return await createWorktree(directory, input, {
        contributorProvenance,
        contributorSource: source,
        hydrateCheckout,
        bootstrapStore: worktreeBootstrapStore,
      });
    } catch (error) {
      if (error?.code === 'CONTRIBUTOR_REMOTE_COLLISION') {
        throw new WorktreeCreationError('Contributor remote name is already used by a different endpoint', 409, 'CONTRIBUTOR_REMOTE_COLLISION', { remoteName: error.remoteName });
      }
      throw error;
    }
  };

  return { validationInput, create };
};
