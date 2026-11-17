import { isString } from '../shared/guards.js';
import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';

const text = (value) => (isString(value) ? value.trim() : '');

const sameAccount = (left, right) => Boolean(left) && Boolean(right)
  && left.provider === right.provider
  && left.instance === right.instance
  && left.accountId === right.accountId;

const accountSignature = (descriptor, user) => {
  const login = text(user?.login) || text(user?.username);
  const userName = text(user?.name) || login;
  const email = text(user?.email);
  if (email) return { userName, userEmail: email };
  const noReply = login && descriptor.identity?.noReplyEmail instanceof Function
    ? descriptor.identity.noReplyEmail({ id: user?.id, login })
    : null;
  return { userName, userEmail: noReply ?? '' };
};

const instanceLabel = (instance) => {
  const value = text(instance);
  try { return new URL(value.includes('://') ? value : `https://${value}`).host; }
  catch { return value; }
};

const uniqueName = (profiles, candidate, account, providerLabel) => {
  const taken = new Set(profiles.map((profile) => text(profile.name).toLowerCase()));
  const free = (name) => !taken.has(name.toLowerCase());
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
}) {
  if (!store || !(store.getProfiles instanceof Function) || !(store.createProfile instanceof Function)
    || !(store.updateProfile instanceof Function)) {
    throw new TypeError('Git identity provisioning dependencies are invalid');
  }

  const provisioned = Object.freeze({
    ensureAccountIdentity: ({ account, user }) => {
      if (!account?.provider || !text(account.instance) || !text(account.accountId)) return null;
      const descriptor = describeProvider(account.provider);
      if (!descriptor) return null;
      const profiles = store.getProfiles();
      const existing = profiles.find((profile) => sameAccount(profile.account, account));
      if (existing) return existing;
      const signature = accountSignature(descriptor, user);
      const sameSignature = signature.userEmail ? profiles.find((profile) => profile.account
        && profile.account.provider === account.provider
        && profile.account.instance === account.instance
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

    backfillAccountIdentities: (accounts) => {
      const created = [];
      for (const entry of accounts ?? []) {
        try {
          const identity = provisioned.ensureAccountIdentity(entry);
          if (identity) created.push(identity);
        } catch {
          // One account that cannot describe itself must not stop the rest.
        }
      }
      return created;
    },

    repointAccountIdentities: ({ from, to }) => {
      if (!sameAccount({ ...from, accountId: 'x' }, { ...to, accountId: 'x' }) || from.accountId === to.accountId) return [];
      return store.getProfiles()
        .filter((profile) => sameAccount(profile.account, from))
        .map((profile) => store.updateProfile(profile.id, { ...profile, account: to }));
    },
  });
  return provisioned;
}
