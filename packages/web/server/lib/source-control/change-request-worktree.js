import { hostOf } from './binding-service.js';
import { redactSensitiveText } from './url-redaction.js';
import { forkRemoteName } from '../git/contributor-remote.js';

/**
 * The change-request source for a worktree made from a pull or merge request
 * given by number, built on the server the way the New worktree dialog builds
 * it on the client (`prWorktreeConfig.ts`, `getBoundSourceControlReadContexts`):
 *
 * - The read context is the repository's: a ready bound provider first, else a
 *   remote on a host a registered provider owns (`auth.ownsHost` over its
 *   default and known instances), read with that host's current account.
 *   Where two contexts could answer, the earlier provider in registry order
 *   wins, as the dialog's picker does (GitHub before GitLab).
 * - The project, head and head revision are the provider's current answer for
 *   that number on the context's primary remote.
 *
 * Nothing from the caller beyond the directory and the number reaches the
 * result; the contributor pipeline then resolves and checks the source again.
 */

/** A remote's host, and its web port when the remote is an HTTP(S) URL (an SSH remote names none). */
const remoteEndpoint = (displayUrl) => {
  const host = hostOf(displayUrl);
  if (!host) return null;
  const text = String(displayUrl).trim();
  if (!/^https?:\/\//i.test(text) || !URL.canParse(text)) return { host };
  const url = new URL(text);
  return { host, port: Number(url.port || (url.protocol === 'http:' ? 80 : 443)) };
};

const sourceControlError = (message, status, code) => Object.assign(new Error(message), { status, code });

/**
 * `providers` is the source-control provider registry: `list()` in priority
 * order and `implementation(id)`, whose `auth.ownsHost` and
 * `auth.listInstances` say which instance a remote's host belongs to.
 */
export const createChangeRequestWorktreeSource = ({
  readBinding,
  providers,
  readCurrentAccountId,
  readChangeRequestHead,
}) => {
  /**
   * Each provider's host owner, in registry order, over its default and known
   * instances. A provider that fails to load or list is left out, so it never
   * blocks the others from answering.
   */
  const hostOwners = async () => {
    const owners = [];
    for (const descriptor of providers.list()) {
      try {
        const impl = await providers.implementation(descriptor.id);
        if (!(impl?.auth?.ownsHost instanceof Function)) continue;
        const knownInstances = [...descriptor.instance.defaultInstances, ...(await impl.auth.listInstances?.()) ?? []];
        owners.push({ provider: descriptor.id, owns: (endpoint) => impl.auth.ownsHost({ ...endpoint, knownInstances }) });
      } catch (error) {
        console.warn(`Skipping ${descriptor.label} for a change request worktree:`, redactSensitiveText(error?.message));
      }
    }
    return owners;
  };
  const identityForEndpoint = (endpoint, owners) => {
    if (!endpoint) return null;
    for (const owner of owners) {
      const instance = owner.owns(endpoint);
      if (instance) return { provider: owner.provider, instance };
    }
    return null;
  };
  // Instances are normalized, so two instances on one host with different ports stay apart.
  const identityKey = (identity) => `${identity.provider}:${identity.instance}`;

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
    const owners = await hostOwners();
    const remotes = [...read.repository.remotes].sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : 0));
    for (const remote of remotes) {
      const identity = identityForEndpoint(remoteEndpoint(remote.push.displayUrl) ?? remoteEndpoint(remote.fetch.displayUrl), owners);
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
    const order = providers.list();
    const context = order.map((descriptor) => contexts.find((candidate) => candidate.provider === descriptor.id)).find(Boolean);
    if (!context) {
      const labels = order.map((descriptor) => descriptor.label);
      const named = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}` : labels.join('');
      throw sourceControlError(`No connected ${named} account can read this project`, 409, 'AUTHENTICATION_REQUIRED');
    }
    const head = await readChangeRequestHead({ context, number });
    return {
      headBranch: head.headBranch,
      sourceRequest: {
        context,
        project: head.project,
        number,
        expectedHeadSha: head.headSha,
        requestedRemoteName: forkRemoteName(head.headOwner),
      },
    };
  };
};
