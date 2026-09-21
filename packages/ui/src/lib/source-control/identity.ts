import type { GitRemote, PageResult, SourceControlAuthAccount, SourceControlBindingRead, SourceControlIdentity, SourceControlProvider, SourceControlReadContext } from '@/lib/api/types';

export const GITHUB_SOURCE_CONTROL_IDENTITY: SourceControlIdentity = { provider: 'github', instance: 'github.com' };
const GITLAB_SOURCE_CONTROL_IDENTITY: SourceControlIdentity = { provider: 'gitlab', instance: 'https://gitlab.com' };

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

export type SourceControlTarget = {
  identity: SourceControlIdentity;
  remote: GitRemote;
};

export const getBoundSourceControlReadContexts = (
  result: SourceControlBindingRead,
  directory: string,
): SourceControlReadContext[] => {
  if (result.status === 'missing') return [];

  return result.binding.providers.filter((provider) => provider.readiness === 'ready'
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
};

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

export const appendMissingSourceControlItems = <T extends { number: number; project: { id: string } }>(
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
  identities: SourceControlIdentity[],
): SourceControlTarget | null => {
  const knownIdentities = [GITHUB_SOURCE_CONTROL_IDENTITY, GITLAB_SOURCE_CONTROL_IDENTITY, ...identities];
  const targets: SourceControlTarget[] = [];
  for (const remote of remotes) {
    const authority = getRemoteAuthority(remote);
    if (!authority) continue;
    const identity = knownIdentities.find((candidate) => getIdentityAuthority(candidate) === authority);
    if (identity) targets.push({ identity, remote });
  }
  return targets.length === 1 ? targets[0] : null;
};

export const resolveSourceControlIdentity = (
  remote: GitRemote | null | undefined,
  identities: SourceControlIdentity[],
): SourceControlIdentity | null => remote
  ? resolveSourceControlTarget([remote], identities)?.identity ?? null
  : null;

export const getSourceControlBaseUrl = (identity: SourceControlIdentity): string => (
  identity.instance.includes('://') ? identity.instance : `https://${identity.instance}`
);

export const getSourceControlProviderLabel = (provider: SourceControlProvider): 'GitHub' | 'GitLab' =>
  provider === 'github' ? 'GitHub' : 'GitLab';

/** GitLab addresses merge requests as `!N`; GitHub addresses pull requests as `#N`. */
export const getChangeRequestReferencePrefix = (provider: SourceControlProvider): '#' | '!' =>
  provider === 'gitlab' ? '!' : '#';

export const formatChangeRequestReference = (provider: SourceControlProvider | null | undefined, number: number): string =>
  `${provider ? getChangeRequestReferencePrefix(provider) : '#'}${number}`;

/**
 * One label shape for every account picker: provider @user · instance · source.
 *
 * The credential's own reference is deliberately absent. It is opaque, it is
 * long enough to hide the account name it sits beside, and a person choosing
 * an account means the person, not one of their stored credentials.
 */
const formatSourceControlAccountLabel = (
  identity: SourceControlIdentity,
  account: { user: { username: string } },
  sourceLabel: string,
): string => `${getSourceControlProviderLabel(identity.provider)} @${account.user.username} · ${identity.instance} · ${sourceLabel}`;

type ManagedCredentialSourceLabelKey =
  | 'settings.github.page.accountSource.oauth'
  | 'settings.github.page.accountSource.cli'
  | 'settings.gitlab.token.label';

export const getManagedCredentialSourceLabelKey = (source: 'oauth' | 'pat' | 'cli'): ManagedCredentialSourceLabelKey => (
  source === 'oauth' ? 'settings.github.page.accountSource.oauth'
    : source === 'cli' ? 'settings.github.page.accountSource.cli'
      : 'settings.gitlab.token.label'
);

/**
 * The host a git remote points at, for `https://host/owner/repo.git` and for
 * the scp-like `git@host:owner/repo.git` alike. A provider association is
 * about which host answers for the repository, not how the bytes travel, so
 * it must recognise an SSH remote too.
 */
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

/**
 * Whether a remote URL travels over SSH: an explicit `ssh://`, or the scp-like
 * `git@host:owner/repo.git`. The scp-like form has no scheme, which is what
 * separates it from `https://host/owner/repo.git` — that also reads as
 * `<word>:<rest>` and would otherwise pass for an SSH remote.
 */
export const isSshRemoteUrl = (remoteUrl: string): boolean => {
  const value = remoteUrl.trim();
  if (value.startsWith('ssh://')) return true;
  return !value.includes('://') && /^(?:[^@/:\s]+@)?[^/:\s]+:[^\s]+$/.test(value);
};

/** What a remote URL allows: which host answers for it and how it can be reached. */
export type RemoteTraits = { host: string | null; https: boolean; ssh: boolean };

export const remoteTraits = (remoteUrl: string): RemoteTraits => {
  const value = remoteUrl.trim();
  return { host: gitRemoteHost(value), https: value.startsWith('https://'), ssh: isSshRemoteUrl(value) };
};

/** The host a provider instance names, whether stored bare or as a URL. */
export const instanceHost = (instance: string): string | null =>
  gitRemoteHost(instance.includes('://') ? instance : `https://${instance}`);

/**
 * The identity to offer for a repository on this host.
 *
 * An identity that already names an account on the host is the answer the
 * person has effectively given: it says both whose repository this is and how
 * to reach it. Failing that, the one marked default, and failing that nothing —
 * proposing an unrelated identity would be a guess wearing a name.
 */
/** The id the identities store gives the person's own Git configuration. */
export const GLOBAL_IDENTITY_ID = 'global';

/**
 * Whether the account an identity names is still connected.
 *
 * Removing an account leaves every identity that named it pointing at a
 * credential that no longer exists; binding a repository to one would produce
 * a grant nothing can answer. An instance whose accounts have not been read
 * yet answers `true`, because "not loaded" is not "not connected".
 */
export const identityAccountConnected = (
  profile: { account?: (SourceControlIdentity & { accountId: string }) | null },
  connectedAccountIds: (account: SourceControlIdentity) => string[] | null,
): boolean => {
  const account = profile.account;
  if (!account) return true;
  const known = connectedAccountIds(account);
  return known === null || known.includes(account.accountId);
};

/**
 * The identities a repository may be given.
 *
 * The System identity is what OpenChamber discovered on this machine, and it
 * is always offered: it is how a person says no override applies here. Stored
 * identities are offered only when they are complete, because an identity that
 * names no account cannot authenticate as anyone.
 */
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

/**
 * The identity a repository is currently acting as.
 *
 * The repository's own author decides it: a stored identity with that
 * signature, else the machine's if it matches, else the author itself shown as
 * it is. A repository that names no author is on the System identity, which is
 * what having no override means — and is why every surface has to answer this
 * the same way.
 */
export const activeIdentityFor = <T extends { id: string; name: string; userName: string; userEmail: string }>(
  profiles: T[],
  systemIdentity: T | null | undefined,
  author: { userName?: string | null; userEmail?: string | null } | null | undefined,
  fromAuthor: (author: { userName: string; userEmail: string }) => T,
): T | null => {
  const userName = author?.userName ?? '';
  const userEmail = author?.userEmail ?? '';
  if (!userName || !userEmail) return systemIdentity ?? null;
  const stored = profiles.find((profile) => profile.userName === userName && profile.userEmail === userEmail);
  if (stored) return stored;
  if (systemIdentity && systemIdentity.userName === userName && systemIdentity.userEmail === userEmail) return systemIdentity;
  return fromAuthor({ userName, userEmail });
};

/** What an identity is called on screen. The System one is named by the product, not by a record. */
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
): T | null => {
  const matching = host
    ? identities.find((identity) => {
      const instance = identity.account?.instance ?? '';
      return instance.length > 0 && instanceHost(instance) === host;
    })
    : undefined;
  if (matching) return matching;
  const preferred = defaultIdentityId?.trim();
  return (preferred && identities.find((identity) => identity.id === preferred))
    // The System identity is what a repository has before anyone chooses; it
    // is the default rather than a guess.
    || identities.find((identity) => identity.id === GLOBAL_IDENTITY_ID)
    || null;
};

type ManagedAccountOption = {
  key: string;
  reference: SourceControlIdentity & { accountId: string };
  label: string;
  source: SourceControlAuthAccount['source'];
};

/**
 * Selectable managed HTTPS credential accounts: one per person.
 *
 * Re-authenticating keeps the credential it replaces, so one account can hold
 * several. Offering each of them separately asks a question nobody can answer
 * — they carry the same name — so the current credential represents the
 * person, and the others stay valid for identities that already name them.
 */
export const buildManagedAccountOptions = (
  identity: SourceControlIdentity,
  accounts: SourceControlAuthAccount[],
  sourceLabel: (account: SourceControlAuthAccount) => string,
): ManagedAccountOption[] => {
  const byProviderUser = new Map<string, SourceControlAuthAccount>();
  for (const account of accounts) {
    if (account.status !== 'valid' || account.source === 'cli') continue;
    const existing = byProviderUser.get(account.providerUserId);
    if (!existing || (account.current && !existing.current)) byProviderUser.set(account.providerUserId, account);
  }
  return [...byProviderUser.values()].map((account) => ({
    key: JSON.stringify([identity.provider, identity.instance, account.id]),
    reference: { ...identity, accountId: account.id },
    label: formatSourceControlAccountLabel(identity, account, sourceLabel(account)),
    source: account.source,
  }));
};
