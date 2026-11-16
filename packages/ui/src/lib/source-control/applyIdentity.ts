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
import { instanceHost, sshInstanceTraits, type RemoteTraits } from './identity';
import { repositoryBindingOwner } from './repository-binding';

export type IdentityApplicability =
  | { applicable: true }
  | { applicable: false; reason: 'host'; host: string }
  | { applicable: false; reason: 'scheme'; scheme: 'https' | 'ssh' };

export const identityApplicability = (
  identity: Pick<GitIdentityProfile, 'account' | 'transport'>,
  remote: RemoteTraits,
  instanceSshHosts: Readonly<Record<string, string>> = {},
): IdentityApplicability => {
  const accountHost = identity.account ? instanceHost(identity.account.instance) : null;
  const ssh = identity.account ? sshInstanceTraits(instanceSshHosts[identity.account.instance] ?? '') : null;
  const onInstanceSsh = Boolean(ssh && remote.ssh && !remote.https
    && remote.host === ssh.host && (remote.sshPort ?? 22) === ssh.port);
  if (accountHost && remote.host && accountHost !== remote.host && !onInstanceSsh) {
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
  remoteName: string | null;
};

type ApplyIdentityAPIs = {
  git: Pick<GitAPI, 'configureTransportBinding' | 'removeTransportBinding' | 'setGitIdentity'>;
  sourceControl: Pick<SourceControlAPI, 'repositoryBinding' | 'repositoryProviderBindingMutate'>;
  runtimeKey?: () => string;
};

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

export const describeIdentityApplicability = (
  applicability: IdentityApplicability,
  t: (key: 'gitView.identity.unavailableHost' | 'gitView.identity.unavailableNeedsHttps' | 'gitView.identity.unavailableNeedsSsh', params?: Record<string, string>) => string,
): string => {
  if (applicability.applicable) return '';
  if (applicability.reason === 'host') return t('gitView.identity.unavailableHost', { host: applicability.host });
  return t(applicability.scheme === 'ssh' ? 'gitView.identity.unavailableNeedsSsh' : 'gitView.identity.unavailableNeedsHttps');
};

export const applyIdentityToRepository = async (
  { directory, identity, remoteName }: ApplyIdentityInput,
  { git, sourceControl, runtimeKey }: ApplyIdentityAPIs,
): Promise<ApplyIdentityOutcome> => {
  const requireRuntime = runtimeGuard(runtimeKey);
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

  try {
    requireRuntime();
  } catch {
    return { status: 'failed', reason: 'runtime' };
  }
  try {
    if (identity.id) {
      if (!git.setGitIdentity) throw new Error('Git identity is unavailable on this runtime');
      await git.setGitIdentity(directory, identity.id);
    }
  } catch {
    if (outcome.status === 'applied') outcome = { status: 'failed', reason: 'author' };
  }
  return outcome;
};

type AuxiliaryGrantAuthority = Omit<GitAuxiliaryBindingIntent & { operation: 'remove' }, 'operation'>;

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
    for (const current of read.repository.remotes) {
      const name = current.name;
      if (name === remoteName) continue;
      const granted = read.binding?.remotes.find((entry) => entry.name === name && !entry.inherited);
      if (!granted || granted.readiness !== 'ready') continue;
      requireRuntime();
      try {
        if (removeTransportBinding) {
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
        outcome = { status: 'failed', reason: 'binding' };
      }
    }
    requireRuntime();
    repositoryBindingOwner.setMutationResult(mutation, read);
  } catch (error) {
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
