import type { SourceControlProviderDescriptor } from './providers/descriptor';
import type { GitRemote, PageResult, SourceControlAuthAccount, SourceControlBindingRead, SourceControlIdentity, SourceControlReadContext } from '@/lib/api/types';

export const GITHUB_SOURCE_CONTROL_IDENTITY: SourceControlIdentity = { provider: 'github', instance: 'github.com' };

export const defaultSourceControlIdentities = (descriptors: readonly SourceControlProviderDescriptor[]): SourceControlIdentity[] => (
  descriptors.flatMap((descriptor) => {
    const instance = descriptor.instances.defaultInstance;
    return instance ? [{ provider: descriptor.id, instance }] : [];
  })
);

const getRemoteAuthority = (remote: GitRemote | null | undefined): string | null => {
  const value = remote?.pushUrl?.trim() || remote?.fetchUrl?.trim();
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    const scpHost = value.match(/^(?:[^@/]+@)?([^:/]+):/u)?.[1];
    return scpHost?.toLowerCase() ?? null;
  }
};

const getIdentityAuthority = (identity: SourceControlIdentity): string => {
  try {
    return new URL(identity.instance.includes('://') ? identity.instance : `https://${identity.instance}`).host.toLowerCase();
  } catch {
    return identity.instance.toLowerCase();
  }
};

type SourceControlTarget = {
  identity: SourceControlIdentity;
  remote: GitRemote;
};

export const getBoundSourceControlReadContexts = (
  result: SourceControlBindingRead,
  directory: string,
  activeAccountFor: (identity: SourceControlIdentity) => string | null = () => null,
  knownIdentities: readonly SourceControlIdentity[] = [],
): SourceControlReadContext[] => {
  const contexts: SourceControlReadContext[] = (result.binding?.providers ?? []).filter((provider) => provider.readiness === 'ready'
    && provider.endpoint?.fingerprint === result.repository.remotes.find((remote) => remote.name === provider.primaryRemote)?.fetch.fingerprint
  ).map((provider) => ({
    directory,
    repositoryId: result.repository.repositoryId,
    provider: provider.provider,
    instance: provider.instance,
    accountId: provider.accountId,
    bindingRevision: result.revision,
    primaryRemote: provider.primaryRemote,
  }));
  const boundInstances = new Set((result.binding?.providers ?? [])
    .filter((provider) => provider.readiness !== 'account-unavailable')
    .map((provider) => getSourceControlAuthKeyOf(provider)));
  const remotes = [...result.repository.remotes].sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : 0));
  for (const remote of remotes) {
    const identity = resolveSourceControlIdentity({ name: remote.name, fetchUrl: remote.fetch.displayUrl, pushUrl: remote.push.displayUrl }, knownIdentities);
    if (!identity || boundInstances.has(getSourceControlAuthKeyOf(identity))) continue;
    const accountId = activeAccountFor(identity);
    if (!accountId) continue;
    boundInstances.add(getSourceControlAuthKeyOf(identity));
    contexts.push({
      directory,
      repositoryId: result.repository.repositoryId,
      provider: identity.provider,
      instance: identity.instance,
      accountId,
      bindingRevision: result.revision,
      primaryRemote: remote.name,
    });
  }
  return contexts;
};

const getSourceControlAuthKeyOf = (identity: SourceControlIdentity): string => `${identity.provider}:${getIdentityAuthority(identity)}`;

export const sourceControlReadContextParts = (context: SourceControlReadContext) => [
  context.provider,
  context.instance,
  context.accountId,
  context.repositoryId,
  context.bindingRevision,
  context.directory,
  context.primaryRemote,
] as const;

export const hasSameSourceControlReadContext = (
  left: SourceControlReadContext,
  right: SourceControlReadContext,
): boolean => left.provider === right.provider
  && left.instance === right.instance
  && left.accountId === right.accountId
  && left.repositoryId === right.repositoryId
  && left.bindingRevision === right.bindingRevision
  && left.directory === right.directory
  && left.primaryRemote === right.primaryRemote;

const appendMissingSourceControlItems = <T extends { number: number; project: { id: string } }>(
  items: T[],
  candidates: T[],
): T[] => {
  const itemKeys = new Set(items.map((item) => `${item.project.id}#${item.number}`));
  return [...items, ...candidates.filter((item) => !itemKeys.has(`${item.project.id}#${item.number}`))];
};

export const mergeIncompleteSourceControlPage = <T extends { number: number; project: { id: string } }>(
  previous: T[],
  next: PageResult<T>,
): T[] => {
  if (!next.incompleteProjectIds?.length) return next.items;
  const incompleteProjects = new Set(next.incompleteProjectIds);
  return appendMissingSourceControlItems(
    next.items,
    previous.filter((item) => incompleteProjects.has(item.project.id)),
  );
};

export const resolveSourceControlTarget = (
  remotes: GitRemote[],
  identities: readonly SourceControlIdentity[],
): SourceControlTarget | null => {
  const targets: SourceControlTarget[] = [];
  for (const remote of remotes) {
    const authority = getRemoteAuthority(remote);
    if (!authority) continue;
    const traits = remoteTraits(remote.pushUrl?.trim() || remote.fetchUrl?.trim() || '');
    const identity = identities.find((candidate) => {
      if (getIdentityAuthority(candidate) === authority) return true;
      const ssh = candidate.instanceSshUrl && traits.ssh ? sshInstanceTraits(candidate.instanceSshUrl) : null;
      return ssh !== null && ssh.host === traits.host?.replace(/\.$/, '') && ssh.port === traits.sshPort;
    });
    if (identity) targets.push({ identity, remote });
  }
  return targets.length === 1 ? targets[0] : null;
};

export const resolveSourceControlIdentity = (
  remote: GitRemote | null | undefined,
  identities: readonly SourceControlIdentity[],
): SourceControlIdentity | null => remote
  ? resolveSourceControlTarget([remote], identities)?.identity ?? null
  : null;

export const getSourceControlBaseUrl = (identity: Pick<SourceControlIdentity, 'instance'>): string => (
  identity.instance.includes('://') ? identity.instance : `https://${identity.instance}`
);

const formatSourceControlAccountLabel = (
  identity: SourceControlIdentity,
  providerLabel: string,
  account: { user: { username: string } },
  sourceLabel: string,
): string => `${providerLabel} @${account.user.username} · ${identity.instance} · ${sourceLabel}`;

type ManagedCredentialSource = 'oauth' | 'pat' | 'cli';

export const getManagedCredentialSourceLabelKey = (
  source: ManagedCredentialSource,
): `settings.sourceControl.accountSource.${ManagedCredentialSource}` => `settings.sourceControl.accountSource.${source}`;

export const gitRemoteHost = (remoteUrl: string): string | null => {
  const value = remoteUrl.trim();
  if (!value) return null;
  const scpLike = /^[^/@]+@([^/:]+):/.exec(value);
  if (scpLike) return scpLike[1].toLowerCase();
  try {
    return new URL(value).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
};

export const isSshRemoteUrl = (remoteUrl: string): boolean => {
  const value = remoteUrl.trim();
  if (value.startsWith('ssh://')) return true;
  return !value.includes('://') && /^(?:[^@/:\s]+@)?[^/:\s]+:[^\s]+$/.test(value);
};

export type RemoteTraits = { host: string | null; https: boolean; ssh: boolean; sshPort?: number };

export const remoteTraits = (remoteUrl: string): RemoteTraits => {
  const value = remoteUrl.trim();
  const ssh = isSshRemoteUrl(value);
  let sshPort: number | undefined;
  if (ssh) {
    if (value.startsWith('ssh://')) {
      try { sshPort = Number(new URL(value).port || 22); }
      catch { sshPort = 22; }
    } else {
      sshPort = 22;
    }
  }
  const traits: RemoteTraits = { host: gitRemoteHost(value), https: value.startsWith('https://'), ssh };
  if (sshPort !== undefined) traits.sshPort = sshPort;
  return traits;
};

export const sshInstanceTraits = (sshUrl: string): { host: string; port: number } | null => {
  const value = sshUrl.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'ssh:' || !url.hostname) return null;
    return { host: url.hostname.toLowerCase().replace(/\.$/, ''), port: Number(url.port || 22) };
  } catch {
    return null;
  }
};

export const instanceHost = (instance: string): string | null =>
  gitRemoteHost(instance.includes('://') ? instance : `https://${instance}`);

export const instanceSshHostsFrom = (identities: readonly SourceControlIdentity[]) => {
  const addresses: Record<string, string> = {};
  for (const identity of identities) {
    if (identity.instanceSshUrl) addresses[identity.instance] = identity.instanceSshUrl;
  }
  return addresses;
};

export const GLOBAL_IDENTITY_ID = 'global';

export const identityAccountConnected = (
  profile: { account?: (SourceControlIdentity & { accountId: string }) | null },
  connectedAccountIds: (account: SourceControlIdentity) => string[] | null,
): boolean => {
  const account = profile.account;
  if (!account) return true;
  const known = connectedAccountIds(account);
  return known === null || known.includes(account.accountId);
};

export const selectableIdentities = <T extends { id: string }>(
  profiles: T[],
  systemIdentity: T | null | undefined,
  isComplete: (profile: T) => boolean,
): T[] => {
  const unique = new Map<string, T>();
  if (systemIdentity) unique.set(systemIdentity.id, systemIdentity);
  for (const profile of profiles) {
    if (profile.id !== GLOBAL_IDENTITY_ID && isComplete(profile)) unique.set(profile.id, profile);
  }
  return [...unique.values()];
};

export const activeIdentityFor = <T extends { id: string; name: string; userName: string; userEmail: string; account?: { accountId: string } | null }>(
  profiles: T[],
  systemIdentity: T | null | undefined,
  author: { userName?: string | null; userEmail?: string | null } | null | undefined,
  fromAuthor: (author: { userName: string; userEmail: string }) => T,
  boundAccountId?: string | null,
): T | null => {
  const userName = author?.userName ?? '';
  const userEmail = author?.userEmail ?? '';
  if (!userName || !userEmail) return systemIdentity ?? null;
  const signedAs = (profile: T) => profile.userName === userName && profile.userEmail === userEmail;
  const systemSignedAs = Boolean(systemIdentity && signedAs(systemIdentity));
  if (boundAccountId) {
    const bound = profiles.find((profile) => profile.account?.accountId === boundAccountId && signedAs(profile));
    if (bound) return bound;
  } else if (boundAccountId === null && systemIdentity && systemSignedAs) {
    return systemIdentity;
  }
  const stored = profiles.find(signedAs);
  if (stored) return stored;
  if (systemIdentity && systemSignedAs) return systemIdentity;
  return fromAuthor({ userName, userEmail });
};

export const identityDisplayName = (
  profile: { id: string; name: string } | null | undefined,
  t: (key: 'gitView.identity.system') => string,
): string => {
  if (!profile) return '';
  return profile.id === GLOBAL_IDENTITY_ID ? t('gitView.identity.system') : profile.name;
};

export const proposeIdentityForHost = <T extends { id: string; account?: { instance: string } | null }>(
  identities: T[],
  host: string | null,
  defaultIdentityId?: string | null,
  instanceSshHosts: Readonly<Record<string, string>> = {},
): T | null => {
  const matching = host
    ? identities.find((identity) => {
      const instance = identity.account?.instance ?? '';
      if (!instance) return false;
      return instanceHost(instance) === host
        || gitRemoteHost(instanceSshHosts[instance] ?? '') === host;
    })
    : undefined;
  if (matching) return matching;
  const preferred = defaultIdentityId?.trim();
  return (preferred && identities.find((identity) => identity.id === preferred))
    || identities.find((identity) => identity.id === GLOBAL_IDENTITY_ID)
    || null;
};

type ManagedAccountOption = {
  key: string;
  reference: SourceControlIdentity & { accountId: string };
  label: string;
  source: SourceControlAuthAccount['source'];
};

export const accountUsableByIdentity = (
  account: Pick<SourceControlAuthAccount, 'source' | 'current' | 'usable'>,
  cliTransport: boolean,
): boolean => account.source !== 'cli'
  || (cliTransport && (account.usable ?? account.current));

export const unavailableAccountReason = (
  account: SourceControlIdentity & { accountId: string },
  listedAccounts: Pick<SourceControlAuthAccount, 'source' | 'current' | 'usable'>[] | null,
  cliTransport: boolean,
): 'cli-not-in-use' | 'gone' => cliTransport
  && account.accountId.includes('#cli:')
  && !listedAccounts?.some((listed) => listed.source === 'cli' && (listed.usable ?? listed.current))
  ? 'cli-not-in-use'
  : 'gone';

export const buildManagedAccountOptions = (
  identity: SourceControlIdentity,
  descriptor: Pick<SourceControlProviderDescriptor, 'label' | 'auth'>,
  accounts: SourceControlAuthAccount[],
  sourceLabel: (account: SourceControlAuthAccount) => string,
): ManagedAccountOption[] => {
  const byPerson = new Map<string, SourceControlAuthAccount>();
  for (const account of accounts) {
    if (account.status !== 'valid' || !accountUsableByIdentity(account, descriptor.auth.cliTransport)) continue;
    const key = `${account.source === 'cli' ? 'cli' : 'stored'}:${account.providerUserId}`;
    const existing = byPerson.get(key);
    if (!existing || (account.current && !existing.current)) byPerson.set(key, account);
  }
  return [...byPerson.values()].map((account) => ({
    key: JSON.stringify([identity.provider, identity.instance, account.id]),
    reference: { ...identity, accountId: account.id },
    label: formatSourceControlAccountLabel(identity, descriptor.label, account, sourceLabel(account)),
    source: account.source,
  }));
};
