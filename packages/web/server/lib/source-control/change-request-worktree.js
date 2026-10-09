import { hostOf } from './binding-service.js';

/**
 * The change-request source for a worktree made from a pull or merge request
 * given by number, built on the server the way the New worktree dialog builds
 * it on the client (`prWorktreeConfig.ts`, `getBoundSourceControlReadContexts`):
 *
 * - The read context is the repository's: a ready bound provider first, else a
 *   remote on GitHub or a known GitLab instance read with that host's current
 *   account. GitHub wins over GitLab, as the dialog's picker does.
 * - The project, head and head revision are the provider's current answer for
 *   that number on the context's primary remote.
 *
 * Nothing from the caller beyond the directory and the number reaches the
 * result; the contributor pipeline then resolves and checks the source again.
 */

const sourceControlError = (message, status, code) => Object.assign(new Error(message), { status, code });

// The client names the fork remote this way; the contributor pipeline renames
// it after the provider's own head owner anyway.
const requestedRemoteName = (owner) => `pr-${String(owner || '').trim().toLowerCase()
  .replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'head'}`;

export const createChangeRequestWorktreeSource = ({
  readBinding,
  listGitLabInstances,
  readCurrentAccountId,
  readChangeRequestHead,
}) => {
  const identityForHost = (host, gitlabInstances) => {
    if (!host) return null;
    if (host === 'github.com') return { provider: 'github', instance: 'github.com' };
    const instance = gitlabInstances.find((candidate) => hostOf(candidate) === host);
    return instance ? { provider: 'gitlab', instance } : null;
  };
  const identityKey = (identity) => `${identity.provider}:${hostOf(identity.instance)}`;

  const readContexts = async (directory) => {
    const read = await readBinding(directory);
    const contextFor = (identity, accountId, primaryRemote) => ({
      directory,
      repositoryId: read.repository.repositoryId,
      provider: identity.provider,
      instance: identity.instance,
      accountId,
      bindingRevision: read.revision,
      primaryRemote,
    });
    const providers = read.binding?.providers ?? [];
    const contexts = providers
      .filter((provider) => provider.readiness === 'ready'
        && provider.endpoint?.fingerprint === read.repository.remotes.find((remote) => remote.name === provider.primaryRemote)?.fetch.fingerprint)
      .map((provider) => contextFor(provider, provider.accountId, provider.primaryRemote));
    // A repository nobody bound to a host, or bound to an account that is
    // gone, is read with that host's current account, as the client does.
    const covered = new Set(providers.filter((provider) => provider.readiness !== 'account-unavailable').map(identityKey));
    const gitlabInstances = ['https://gitlab.com', ...await listGitLabInstances()];
    const remotes = [...read.repository.remotes].sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : 0));
    for (const remote of remotes) {
      const identity = identityForHost(hostOf(remote.push.displayUrl) ?? hostOf(remote.fetch.displayUrl), gitlabInstances);
      if (!identity || covered.has(identityKey(identity))) continue;
      const accountId = await readCurrentAccountId(identity);
      if (!accountId) continue;
      covered.add(identityKey(identity));
      contexts.push(contextFor(identity, accountId, remote.name));
    }
    return contexts;
  };

  return async ({ directory, number }) => {
    const contexts = await readContexts(directory);
    const context = contexts.find((candidate) => candidate.provider === 'github')
      ?? contexts.find((candidate) => candidate.provider === 'gitlab');
    if (!context) {
      throw sourceControlError('No connected GitHub or GitLab account can read this project', 409, 'AUTHENTICATION_REQUIRED');
    }
    const head = await readChangeRequestHead({ context, number });
    return {
      headBranch: head.headBranch,
      sourceRequest: {
        context,
        project: head.project,
        number,
        expectedHeadSha: head.headSha,
        requestedRemoteName: requestedRemoteName(head.headOwner),
      },
    };
  };
};
