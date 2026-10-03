import type {
  GitAPI,
  GitAuxiliaryBindingIntent,
  GitIdentityProfile,
  GitTransportBindingIntent,
  SourceControlAPI,
  SourceControlBindingRead,
} from '@/lib/api/types';
import { identityTransport } from '@/lib/api/git-identity';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { instanceHost, remoteTraits, type RemoteTraits } from './identity';
import { repositoryBindingOwner } from './repository-binding';

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
  | { status: 'failed'; reason: 'binding' | 'author' | 'runtime' };

type ApplyIdentityInput = {
  directory: string;
  identity: GitIdentityProfile;
  /** The remote the identity's account answers for, or null when the repository has none. */
  remoteName: string | null;
};

type ApplyIdentityAPIs = {
  git: Pick<GitAPI, 'configureTransportBinding' | 'removeTransportBinding' | 'setGitIdentity'>;
  sourceControl: Pick<SourceControlAPI, 'repositoryBinding' | 'repositoryProviderBindingMutate'>;
  /** The active runtime; defaults to the app's. */
  runtimeKey?: () => string;
};

/**
 * Thrown when the person switched runtimes while an identity was being
 * applied. The APIs resolve the current endpoint on every call, so anything
 * written after the switch would land on the other machine's repository at the
 * same path.
 */
class StaleRuntimeError extends Error {
  constructor() {
    super('stale-runtime');
    this.name = 'StaleRuntimeError';
  }
}

const runtimeGuard = (runtimeKey: () => string = getRuntimeKey): () => void => {
  const captured = runtimeKey();
  return () => {
    if (runtimeKey() !== captured) throw new StaleRuntimeError();
  };
};

/**
 * The binding an identity asks for, or null when it names nothing to bind.
 *
 * System Git is what a repository uses when nothing else was chosen, so it
 * needs no confirmation: the grant only records that this is the choice.
 */
const transportIntent = (
  identity: GitIdentityProfile,
  read: SourceControlBindingRead,
  remoteName: string,
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
  if (transport === 'system') return { ...authority, transport: 'system', unverifiedConfirmed: true };
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
  { directory, identity, remoteName }: ApplyIdentityInput,
  { git, sourceControl, runtimeKey }: ApplyIdentityAPIs,
): Promise<ApplyIdentityOutcome> => {
  const requireRuntime = runtimeGuard(runtimeKey);
  // The transfer half needs a remote to answer for and a runtime that holds
  // bindings — VS Code holds none.
  let outcome: ApplyIdentityOutcome = remoteName && git.configureTransportBinding
    ? await applyBinding(
      { directory, identity, remoteName },
      {
        configureTransportBinding: git.configureTransportBinding,
        removeTransportBinding: git.removeTransportBinding,
        sourceControl,
        requireRuntime,
      },
    )
    : { status: 'applied' };
  if (outcome.status === 'failed' && outcome.reason === 'runtime') return outcome;

  // The signature is written to the repository itself, so it is applied even
  // when the transfer side could not be. The system identity is applied the
  // same way: its id removes the repository's own author instead of naming one,
  // which is what "no override applies here" means.
  try {
    requireRuntime();
  } catch {
    return { status: 'failed', reason: 'runtime' };
  }
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
): GitAuxiliaryBindingIntent | null => {
  const operation = 'configure' as const;
  const transport = identityTransport(identity);
  if (transport === 'system') return { ...authority, operation, transport, unverifiedConfirmed: true };
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
  { directory, identity, remoteName }: {
    directory: string; identity: GitIdentityProfile; remoteName: string;
  },
  { git, sourceControl, runtimeKey }: ApplyIdentityAPIs,
): Promise<ApplyIdentityOutcome> => {
  if (!git.configureTransportBinding) return { status: 'failed', reason: 'binding' };
  const requireRuntime = runtimeGuard(runtimeKey);
  const isRuntime = () => {
    try {
      requireRuntime();
      return true;
    } catch {
      return false;
    }
  };
  const scope = repositoryBindingOwner.scope(directory);
  let read: SourceControlBindingRead;
  try {
    read = await sourceControl.repositoryBinding(directory);
  } catch {
    return { status: 'failed', reason: 'binding' };
  }
  const intent = transportIntent(identity, read, remoteName, directory);
  if (!intent) return { status: 'failed', reason: 'binding' };
  try {
    requireRuntime();
  } catch {
    return { status: 'failed', reason: 'runtime' };
  }
  const mutation = repositoryBindingOwner.captureMutation(scope, read);
  let outcome: ApplyIdentityOutcome = { status: 'applied' };
  try {
    const result = await git.configureTransportBinding(intent);
    requireRuntime();
    if (result.status === 'configured') {
      repositoryBindingOwner.setMutationResult(mutation, result.binding);
    } else {
      await repositoryBindingOwner.reconcile(mutation, sourceControl);
    }
  } catch (error) {
    if (error instanceof StaleRuntimeError || !isRuntime()) return { status: 'failed', reason: 'runtime' };
    outcome = { status: 'failed', reason: 'binding' };
    await repositoryBindingOwner.reconcile(mutation, sourceControl);
  } finally {
    mutation.release();
  }
  return outcome;
};

/** The account and transport half of an identity, written through the binding owner. */
const applyBinding = async (
  { directory, identity, remoteName }: {
    directory: string; identity: GitIdentityProfile; remoteName: string;
  },
  { configureTransportBinding, removeTransportBinding, sourceControl, requireRuntime }: {
    configureTransportBinding: NonNullable<GitAPI['configureTransportBinding']>;
    removeTransportBinding: GitAPI['removeTransportBinding'];
    sourceControl: ApplyIdentityAPIs['sourceControl'];
    requireRuntime: () => void;
  },
): Promise<ApplyIdentityOutcome> => {
  const scope = repositoryBindingOwner.scope(directory);
  let read: SourceControlBindingRead;
  try {
    read = await sourceControl.repositoryBinding(directory);
  } catch {
    return { status: 'failed', reason: 'binding' };
  }
  try {
    requireRuntime();
  } catch {
    return { status: 'failed', reason: 'runtime' };
  }
  const mutation = repositoryBindingOwner.captureMutation(scope, read);
  let outcome: ApplyIdentityOutcome = { status: 'applied' };
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
    requireRuntime();
    if (identity.account) {
      const provider = { ...identity.account, primaryRemote: remoteName };
      read = await sourceControl.repositoryProviderBindingMutate(target
        ? { ...context, operation: 'replace', target, provider }
        : { ...context, operation: 'add', provider });
    } else if (target) {
      read = await sourceControl.repositoryProviderBindingMutate({ ...context, operation: 'remove', target });
    }
    const intent = transportIntent(identity, read, remoteName, directory);
    if (intent) {
      requireRuntime();
      const result = await configureTransportBinding(intent);
      if (result.status === 'configured') read = result.binding;
    }
    // The identity is the whole answer for this repository, so every address
    // it can serve follows it: a fork beside its upstream answers as the same
    // person without being named twice. One it cannot serve — another
    // instance, an address its transport cannot reach — keeps no grant, and
    // the repository configuration offers it separately.
    for (const current of read.repository.remotes) {
      const name = current.name;
      if (name === remoteName) continue;
      const granted = read.binding?.remotes.find((entry) => entry.name === name);
      // A grant whose address moved under it, or whose credential is already
      // in question, is flagged for attention on its own and cannot be
      // rewritten from here: the authority it was written against is gone.
      if (granted && granted.readiness !== 'ready') continue;
      const fits = identityApplicability(identity, remoteTraits(current.fetch.displayUrl)).applicable;
      const next = fits ? transportIntent(identity, read, name, directory) : null;
      requireRuntime();
      try {
        if (next) {
          const result = await configureTransportBinding(next);
          if (result.status === 'configured') read = result.binding;
        } else if (granted && removeTransportBinding) {
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
    requireRuntime();
    repositoryBindingOwner.setMutationResult(mutation, read);
  } catch (error) {
    // Another runtime's binding is not this repository's: nothing read from
    // it may reconcile the owner, and nothing more is written.
    if (error instanceof StaleRuntimeError) return { status: 'failed', reason: 'runtime' };
    try {
      requireRuntime();
    } catch {
      return { status: 'failed', reason: 'runtime' };
    }
    outcome = { status: 'failed', reason: 'binding' };
    await repositoryBindingOwner.reconcile(mutation, sourceControl);
  } finally {
    mutation.release();
  }
  return outcome;
};
