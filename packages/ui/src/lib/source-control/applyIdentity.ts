import type {
  GitAPI,
  GitAuxiliaryBindingIntent,
  GitIdentityProfile,
  GitTransportBindingIntent,
  SourceControlAPI,
  SourceControlBindingRead,
} from '@/lib/api/types';
import { identityTransport } from '@/lib/api/git-identity';
import { instanceHost, remoteTraits, type RemoteTraits, GLOBAL_IDENTITY_ID } from './identity';
import { repositoryBindingOwner } from './repository-binding';
import { recordDeferredOpenCodeRestart } from '@/lib/opencode/deferredRestart';

export type IdentityApplicability =
  | { applicable: true }
  | { applicable: false; reason: 'host'; host: string }
  | { applicable: false; reason: 'scheme'; scheme: 'https' | 'ssh' };

/**
 * Whether an identity can serve a repository on this remote.
 *
 * An identity is specific to an instance: one that acts as an account on
 * gitlab.com cannot answer for a repository on a self-managed GitLab, whatever
 * its transport. And a transport has to be able to reach the address — an
 * account's credential and anonymous reads travel over HTTPS, a managed key
 * over SSH. System Git reaches whatever the machine reaches.
 */
export const identityApplicability = (
  identity: Pick<GitIdentityProfile, 'account' | 'transport'>,
  remote: RemoteTraits,
): IdentityApplicability => {
  const accountHost = identity.account ? instanceHost(identity.account.instance) : null;
  if (accountHost && remote.host && accountHost !== remote.host) {
    return { applicable: false, reason: 'host', host: accountHost };
  }
  const transport = identityTransport(identity);
  if ((transport === 'account' || transport === 'anonymous') && !remote.https) {
    return { applicable: false, reason: 'scheme', scheme: 'https' };
  }
  if (transport === 'ssh' && !remote.ssh) return { applicable: false, reason: 'scheme', scheme: 'ssh' };
  return { applicable: true };
};

type ApplyIdentityOutcome =
  | { status: 'applied' }
  | { status: 'acknowledgement-required' }
  | { status: 'failed'; reason: 'binding' | 'author' };

type ApplyIdentityInput = {
  directory: string;
  identity: GitIdentityProfile;
  /** The remote the identity answers for, or null when the repository has none. */
  remoteName: string | null;
  /** Passing System Git on means the person confirmed the unverified transport. */
  acknowledgedSystem?: boolean;
};

type ApplyIdentityAPIs = {
  git: Pick<GitAPI, 'configureTransportBinding' | 'removeTransportBinding' | 'setGitIdentity'>;
  sourceControl: Pick<SourceControlAPI, 'repositoryBinding' | 'repositoryProviderBindingMutate'>;
};

/**
 * The binding an identity asks for, or null when it names nothing to bind.
 *
 * System Git is a decision about trusting whatever the machine holds, so it is
 * only written once someone has said so.
 */
const transportIntent = (
  identity: GitIdentityProfile,
  read: SourceControlBindingRead,
  remoteName: string,
  acknowledgedSystem: boolean,
  directory: string,
): GitTransportBindingIntent | null => {
  const remote = read.repository.remotes.find((entry) => entry.name === remoteName);
  if (!remote) return null;
  const authority = {
    directory,
    expectedRepositoryId: read.repository.repositoryId,
    expectedRevision: read.revision,
    expectedConfigRevision: read.repository.configRevision,
    expectedFetchFingerprint: remote.fetch.fingerprint,
    expectedPushFingerprint: remote.push.fingerprint,
    remote: remoteName,
  };
  const transport = identityTransport(identity);
  if (transport === 'account' && identity.account) {
    return { ...authority, transport: 'https', credentialAccount: identity.account };
  }
  if (transport === 'ssh' && identity.sshCredentialId) {
    return { ...authority, transport: 'ssh', sshCredentialId: identity.sshCredentialId };
  }
  if (transport === 'anonymous') return { ...authority, transport: 'anonymous' };
  if (transport === 'system' && acknowledgedSystem) {
    return { ...authority, transport: 'system', unverifiedConfirmed: true };
  }
  return null;
};

/** The words for an identity that cannot serve a remote, next to its name. */
export const describeIdentityApplicability = (
  applicability: IdentityApplicability,
  t: (key: 'gitView.identity.unavailableHost' | 'gitView.identity.unavailableScheme', params?: Record<string, string>) => string,
): string => {
  if (applicability.applicable) return '';
  return applicability.reason === 'host'
    ? t('gitView.identity.unavailableHost', { host: applicability.host })
    : t('gitView.identity.unavailableScheme', { scheme: applicability.scheme === 'ssh' ? 'SSH' : 'HTTPS' });
};

/**
 * An identity written before identities carried an account.
 *
 * In the release that made them, choosing one wrote the repository's author
 * and nothing else — no provider association, no transport grant. That is
 * exactly what it keeps doing here: a signature, offered as it always was.
 * New identities cannot be made this way; the completeness rule owns those.
 */
export const isSignatureOnlyIdentity = (
  identity: Pick<GitIdentityProfile, 'id' | 'account' | 'transport'>,
): boolean => identity.id !== GLOBAL_IDENTITY_ID && !identity.account && identityTransport(identity) === 'system';

/**
 * Whether applying this identity has to be confirmed first.
 *
 * A System Git identity says "use whatever this machine holds", and
 * OpenChamber cannot tell whose credentials those are. Asking beforehand keeps
 * a cancelled choice from leaving a signature written and a transport refused.
 * A repository with no remote binds nothing, so there is nothing to confirm.
 */
export const needsSystemAcknowledgement = (
  identity: Pick<GitIdentityProfile, 'id' | 'account' | 'transport'>,
  hasBindableRemote: boolean,
): boolean => hasBindableRemote && identityTransport(identity) === 'system'
  // A signature-only identity claims no credentials at all, so it binds
  // nothing and there is nothing to confirm.
  && !isSignatureOnlyIdentity(identity);

/**
 * Writes one identity onto a repository.
 *
 * The three answers a repository needs — whose issues these are, how transfers
 * authenticate, and who commits — are what an identity is, so applying it
 * writes all three rather than asking for them one control at a time.
 *
 * A part that cannot be written leaves the others written: half a binding is
 * more useful than none, and the strip and the panel show what is still
 * missing.
 */
export const applyIdentityToRepository = async (
  { directory, identity, remoteName, acknowledgedSystem = false }: ApplyIdentityInput,
  { git, sourceControl }: ApplyIdentityAPIs,
): Promise<ApplyIdentityOutcome> => {
  // The transfer half needs a remote to answer for and a runtime that holds
  // bindings — VS Code holds none — and an identity that actually names a way
  // to authenticate. A signature-only identity has none, so it writes the
  // author and leaves the repository's account and transport as they were.
  let outcome: ApplyIdentityOutcome = remoteName && git.configureTransportBinding && !isSignatureOnlyIdentity(identity)
    ? await applyBinding(
      { directory, identity, remoteName, acknowledgedSystem },
      { configureTransportBinding: git.configureTransportBinding, removeTransportBinding: git.removeTransportBinding, sourceControl },
    )
    : { status: 'applied' };

  // The signature is written to the repository itself, so it is applied even
  // when the transfer side could not be. The system identity is applied the
  // same way: its id removes the repository's own author instead of naming one,
  // which is what "no override applies here" means.
  try {
    if (identity.id) await git.setGitIdentity(directory, identity.id);
  } catch {
    if (outcome.status === 'applied') outcome = { status: 'failed', reason: 'author' };
  }
  return outcome;
};

/** What a checkout-hydration grant needs beyond the identity that answers for it. */
type AuxiliaryGrantAuthority = Omit<GitAuxiliaryBindingIntent & { operation: 'remove' }, 'operation'>;

/**
 * The grant an identity gives one submodule or Git LFS endpoint.
 *
 * A submodule server authenticates the way a remote does, so the endpoint is
 * answered with an identity and this puts that answer in the terms the binding
 * is written in. Null means the identity names no way to reach the endpoint:
 * an account with no credential, a key that is not there, or System Git before
 * anyone has said they trust whatever the machine holds.
 */
export const auxiliaryGrantIntent = (
  identity: GitIdentityProfile,
  authority: AuxiliaryGrantAuthority,
  acknowledgedSystem: boolean,
): GitAuxiliaryBindingIntent | null => {
  const operation = 'configure' as const;
  const transport = identityTransport(identity);
  // An identity from an earlier release claims no credentials at all, so
  // confirming System Git on its behalf would grant what it never named.
  if (isSignatureOnlyIdentity(identity)) return null;
  if (transport === 'system') {
    return acknowledgedSystem ? { ...authority, operation, transport, unverifiedConfirmed: true } : null;
  }
  if (transport === 'account' && identity.account) {
    return { ...authority, operation, transport: 'https', credentialAccount: identity.account };
  }
  if (transport === 'ssh' && identity.sshCredentialId) {
    return { ...authority, operation, transport, sshCredentialId: identity.sshCredentialId };
  }
  if (transport === 'anonymous') return { ...authority, operation, transport };
  return null;
};

/**
 * Lets the repository's identity answer for one more of its remotes.
 *
 * A repository can carry a second address — a fork beside the upstream it was
 * cloned from — and the identity was written for the one it was applied to.
 * The other stays unreachable until someone says so here, because a grant is
 * given to an exact endpoint, never to a whole host: `github.com` is where a
 * person's own fork lives and where a stranger's does.
 *
 * Only the transfer half is written. Which account the repository answers to,
 * and who commits, were decided when the identity was applied and are not
 * revisited by naming one more address.
 */
export const grantIdentityToRemote = async (
  { directory, identity, remoteName, acknowledgedSystem = false }: {
    directory: string; identity: GitIdentityProfile; remoteName: string; acknowledgedSystem?: boolean;
  },
  { git, sourceControl }: ApplyIdentityAPIs,
): Promise<ApplyIdentityOutcome> => {
  if (!git.configureTransportBinding || isSignatureOnlyIdentity(identity)) {
    return { status: 'failed', reason: 'binding' };
  }
  const scope = repositoryBindingOwner.scope(directory);
  let read: SourceControlBindingRead;
  try {
    read = await sourceControl.repositoryBinding(directory);
  } catch {
    return { status: 'failed', reason: 'binding' };
  }
  const intent = transportIntent(identity, read, remoteName, acknowledgedSystem, directory);
  if (!intent) {
    return identityTransport(identity) === 'system' ? { status: 'acknowledgement-required' } : { status: 'failed', reason: 'binding' };
  }
  const mutation = repositoryBindingOwner.captureMutation(scope, read);
  const remoteIsHttps = read.repository.remotes.find((entry) => entry.name === remoteName)
    ?.fetch.displayUrl.startsWith('https://') ?? false;
  let outcome: ApplyIdentityOutcome = { status: 'applied' };
  try {
    const result = await git.configureTransportBinding(intent);
    if (result.status === 'configured') {
      repositoryBindingOwner.setMutationResult(mutation, result.binding);
      // Git in the agent's shell learns an HTTPS host only from the environment
      // the managed OpenCode child starts with, so a newly granted one asks for
      // a restart the way the first grant does. A key travels over SSH and
      // never through the credential helper, so it asks for nothing.
      if (remoteIsHttps && (intent.transport === 'https' || intent.transport === 'system')) {
        recordDeferredOpenCodeRestart('cli', { id: `agent-git:${directory}` });
      }
    } else {
      await repositoryBindingOwner.reconcile(mutation, sourceControl);
    }
  } catch {
    outcome = { status: 'failed', reason: 'binding' };
    await repositoryBindingOwner.reconcile(mutation, sourceControl);
  } finally {
    mutation.release();
  }
  return outcome;
};

/** The account and transport half of an identity, written through the binding owner. */
const applyBinding = async (
  { directory, identity, remoteName, acknowledgedSystem }: {
    directory: string; identity: GitIdentityProfile; remoteName: string; acknowledgedSystem: boolean;
  },
  { configureTransportBinding, removeTransportBinding, sourceControl }: {
    configureTransportBinding: NonNullable<GitAPI['configureTransportBinding']>;
    removeTransportBinding: GitAPI['removeTransportBinding'];
    sourceControl: ApplyIdentityAPIs['sourceControl'];
  },
): Promise<ApplyIdentityOutcome> => {
  const scope = repositoryBindingOwner.scope(directory);
  let read: SourceControlBindingRead;
  try {
    read = await sourceControl.repositoryBinding(directory);
  } catch {
    return { status: 'failed', reason: 'binding' };
  }
  const mutation = repositoryBindingOwner.captureMutation(scope, read);
  let outcome: ApplyIdentityOutcome = { status: 'applied' };
  // Git in the agent's shell learns about an HTTPS host only when the managed
  // OpenCode child starts with it in its environment, so the first credential
  // grant on a remote asks for a restart the way other configuration does.
  const previousGrant = read.binding?.remotes.find((entry) => entry.name === remoteName);
  const remoteIsHttps = read.repository.remotes.find((entry) => entry.name === remoteName)
    ?.fetch.displayUrl.startsWith('https://') ?? false;
  const agentGitAnswered = Boolean(previousGrant && (previousGrant.mode === 'managed' || previousGrant.mode === 'system'));
  try {
    // The identity is the whole answer for this repository, so an identity
    // that names no account leaves it answering to none — the account it used
    // to answer to was the previous identity's, not this one's.
    const bound = read.binding?.providers[0];
    const target = bound && {
      provider: bound.provider,
      instance: bound.instance,
      accountId: bound.accountId,
      primaryRemote: bound.primaryRemote,
    };
    const context = {
      directory,
      expectedRepositoryId: read.repository.repositoryId,
      expectedRevision: read.revision,
    };
    if (identity.account) {
      const provider = { ...identity.account, primaryRemote: remoteName };
      read = await sourceControl.repositoryProviderBindingMutate(target
        ? { ...context, operation: 'replace', target, provider }
        : { ...context, operation: 'add', provider });
    } else if (target) {
      read = await sourceControl.repositoryProviderBindingMutate({ ...context, operation: 'remove', target });
    }
    const intent = transportIntent(identity, read, remoteName, acknowledgedSystem, directory);
    if (intent) {
      const result = await configureTransportBinding(intent);
      if (result.status === 'configured') {
        read = result.binding;
        if (remoteIsHttps && !agentGitAnswered && (intent.transport === 'https' || intent.transport === 'system')) {
          recordDeferredOpenCodeRestart('cli', { id: `agent-git:${directory}` });
        }
      }
    } else if (identityTransport(identity) === 'system') {
      outcome = { status: 'acknowledgement-required' };
    }
    // The identity is the whole answer for this repository, so the other
    // addresses it was already given follow it rather than keeping the
    // previous person's credential. One it cannot serve — another instance,
    // an address its transport cannot reach — loses its grant instead, and is
    // offered again beside the repository's own remotes.
    for (const name of (read.binding?.remotes ?? []).map((entry) => entry.name)) {
      if (name === remoteName) continue;
      const current = read.repository.remotes.find((entry) => entry.name === name);
      const granted = read.binding?.remotes.find((entry) => entry.name === name);
      // A grant whose address moved under it, or whose credential is already
      // in question, is flagged for attention on its own and cannot be
      // rewritten from here: the authority it was written against is gone.
      if (!current || granted?.readiness !== 'ready') continue;
      const fits = identityApplicability(identity, remoteTraits(current.fetch.displayUrl)).applicable;
      const next = fits ? transportIntent(identity, read, name, acknowledgedSystem, directory) : null;
      try {
        if (next) {
          const result = await configureTransportBinding(next);
          if (result.status === 'configured') read = result.binding;
        } else if (removeTransportBinding) {
          const result = await removeTransportBinding({
            directory,
            expectedRepositoryId: read.repository.repositoryId,
            expectedRevision: read.revision,
            expectedConfigRevision: read.repository.configRevision,
            expectedFetchFingerprint: current.fetch.fingerprint,
            expectedPushFingerprint: current.push.fingerprint,
            remote: name,
          });
          if (result.status === 'removed') read = result.binding;
        }
      } catch {
        // One address that could not follow leaves the rest as they are; the
        // repository configuration shows what is still unanswered.
        outcome = { status: 'failed', reason: 'binding' };
      }
    }
    repositoryBindingOwner.setMutationResult(mutation, read);
  } catch {
    outcome = { status: 'failed', reason: 'binding' };
    await repositoryBindingOwner.reconcile(mutation, sourceControl);
  } finally {
    mutation.release();
  }
  return outcome;
};
