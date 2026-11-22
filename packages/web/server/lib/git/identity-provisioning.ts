import { isString } from '../shared/guards.js';
import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';
import type { AccountIdentity, ProviderDescriptor, ConnectedAccount } from '../source-control/provider-contract.js';

export interface ProvisioningProfile {
  id: string;
  userName: string;
  userEmail: string;
  name?: unknown;
  account?: unknown;
}
export interface ProvisioningProfileInput extends ProvisioningProfile {
  account: Partial<AccountIdentity>;
  transport: 'account';
  color: string;
  icon: string;
}
export interface AccountProvisioningInput {
  account?: Partial<AccountIdentity> | null;
  user?: Partial<ConnectedAccount['user']> | null;
}
export interface GitIdentityProvisioningOptions {
  store: {
    getProfiles(): ProvisioningProfile[];
    createProfile(profile: ProvisioningProfileInput): ProvisioningProfile;
    updateProfile(id: string, updates: ProvisioningProfile): ProvisioningProfile;
  };
  describeProvider?: (provider: string) => ProviderDescriptor | null | undefined;
  now?: () => number;
  randomId?: () => string;
}
const hasAccountFields = (value: unknown): value is { provider?: unknown; instance?: unknown; accountId?: unknown } =>
  value !== null && value !== undefined;
const accountFields = <Value>(value: Value) => hasAccountFields(value) ? value : undefined;

const text = <Value>(value: Value) => (isString(value) ? value.trim() : '');

const sameAccount = <Left, Right>(left: Left, right: Right) => Boolean(left) && Boolean(right)
  && accountFields(left)?.provider === accountFields(right)?.provider
  && accountFields(left)?.instance === accountFields(right)?.instance
  && accountFields(left)?.accountId === accountFields(right)?.accountId;

const accountSignature = (descriptor: ProviderDescriptor, user: AccountProvisioningInput['user']) => {
  const login = text(user?.login) || text(user?.username);
  const userName = text(user?.name) || login;
  const email = text(user?.email);
  if (email) return { userName, userEmail: email };
  const noReply = login && descriptor.identity?.noReplyEmail instanceof Function
    ? descriptor.identity.noReplyEmail({ id: user?.id, login })
    : null;
  return { userName, userEmail: noReply ?? '' };
};

const instanceLabel = <Value>(instance: Value) => {
  const value = text(instance);
  try { return new URL(value.includes('://') ? value : `https://${value}`).host; }
  catch { return value; }
};

const uniqueName = (profiles: ProvisioningProfile[], candidate: string, account: Partial<AccountIdentity>, providerLabel: string) => {
  const taken = new Set(profiles.map((profile) => text(profile.name).toLowerCase()));
  const free = (name: string) => !taken.has(name.toLowerCase());
  if (free(candidate)) return candidate;
  const provider = providerLabel;
  if (provider && free(`${candidate} (${provider})`)) return `${candidate} (${provider})`;
  const host = instanceLabel(account?.instance);
  if (host && free(`${candidate} (${host})`)) return `${candidate} (${host})`;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const next = `${candidate} ${suffix}`;
    if (free(next)) return next;
  }
  return `${candidate} ${Date.now()}`;
};

export function createGitIdentityProvisioning({
  store,
  describeProvider = sourceControlProviderDescriptors.get,
  now = Date.now,
  randomId = () => Math.random().toString(36).slice(2, 9),
}: GitIdentityProvisioningOptions) {
  if (!store || !(store.getProfiles instanceof Function) || !(store.createProfile instanceof Function)
    || !(store.updateProfile instanceof Function)) {
    throw new TypeError('Git identity provisioning dependencies are invalid');
  }

  const provisioned = Object.freeze({
    ensureAccountIdentity: ({ account, user }: AccountProvisioningInput): ProvisioningProfile | null => {
      if (!account?.provider || !text(account.instance) || !text(account.accountId)) return null;
      const descriptor = describeProvider(account.provider);
      if (!descriptor) return null;
      const profiles = store.getProfiles();
      const existing = profiles.find((profile) => sameAccount(profile.account, account));
      if (existing) return existing;
      const signature = accountSignature(descriptor, user);
      const sameSignature = signature.userEmail ? profiles.find((profile) => profile.account
        && accountFields(profile.account)?.provider === account.provider
        && accountFields(profile.account)?.instance === account.instance
        && profile.userEmail === signature.userEmail) : null;
      if (sameSignature) return store.updateProfile(sameSignature.id, { ...sameSignature, account });
      if (!signature.userName || !signature.userEmail) return null;
      const login = text(user?.login) || text(user?.username) || signature.userName;
      return store.createProfile({
        id: `identity-${now()}-${randomId()}`,
        name: uniqueName(profiles, login, account, descriptor.label),
        userName: signature.userName,
        userEmail: signature.userEmail,
        account,
        transport: 'account',
        color: 'keyword',
        icon: descriptor.iconId,
      });
    },

    backfillAccountIdentities: (accounts: AccountProvisioningInput[] | null | undefined) => {
      const created: ProvisioningProfile[] = [];
      for (const entry of accounts ?? []) {
        try {
          const identity = provisioned.ensureAccountIdentity(entry);
          if (identity) created.push(identity);
        } catch {
          continue;
        }
      }
      return created;
    },

    repointAccountIdentities: ({ from, to }: { from: AccountIdentity; to: AccountIdentity }) => {
      if (!sameAccount({ ...from, accountId: 'x' }, { ...to, accountId: 'x' }) || from.accountId === to.accountId) return [];
      return store.getProfiles()
        .filter((profile) => sameAccount(profile.account, from))
        .map((profile) => store.updateProfile(profile.id, { ...profile, account: to }));
    },
  });
  return provisioned;
}
