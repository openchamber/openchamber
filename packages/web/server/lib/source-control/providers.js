import { isString } from '../shared/guards.js';
import { normalizeGitLabInstance } from '../gitlab/instance.js';

/**
 * The source-control providers this build knows about.
 *
 * Adding one here is not enough: its module must be registered in
 * `source-control/routes.js` and its routes must exist. Everything that only
 * needs to accept or name the provider reads this list.
 */
export const SOURCE_CONTROL_PROVIDERS = Object.freeze(['github', 'gitlab', 'gitea']);

export const isSourceControlProvider = (value) => SOURCE_CONTROL_PROVIDERS.includes(value);

/**
 * Providers whose module is registered in this build.
 *
 * Reads accept every provider in the contract, so a store written by a newer
 * build stays readable. Writes and transports use this shorter list: until a
 * provider has routes, persisting a binding for it would promise a repository
 * access nothing can answer, and older builds would reject the whole store.
 */
export const REGISTERED_SOURCE_CONTROL_PROVIDERS = Object.freeze(['github', 'gitlab']);

export const isRegisteredSourceControlProvider = (value) => REGISTERED_SOURCE_CONTROL_PROVIDERS.includes(value);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const normalizeGitHubInstance = (value) => {
  const raw = isString(value) ? value.trim() : '';
  if (!raw) throw new Error('GitHub instance is required');

  let host = raw.toLowerCase().replace(/\.$/, '');
  if (host.includes('://')) {
    const url = new URL(host);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || (url.pathname && url.pathname !== '/')) throw new Error('GitHub instance must be an HTTPS origin');
    host = url.hostname.toLowerCase().replace(/\.$/, '');
  }
  if (host !== 'github.com') throw new Error('GitHub instance is unsupported');
  return 'github.com';
};

const normalizeGiteaInstance = (value) => {
  const raw = isString(value) ? value.trim() : '';
  if (!raw) throw new Error('Gitea instance is required');

  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error('Invalid Gitea instance URL');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error('Gitea instance must be an origin');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Gitea instances must use HTTPS');
  }
  return url.origin;
};

/**
 * What a provider is, beyond its name.
 *
 * Only behaviour that reaches across modules lives here. Routes, auth and
 * mapping stay in the provider's own module; the traits exist so shared code
 * never decides provider behaviour with `provider === 'gitlab'`.
 */
export const PROVIDER_TRAITS = Object.freeze({
  github: Object.freeze({
    id: 'github',
    label: 'GitHub',
    defaultInstance: 'github.com',
    bareInstance: true,
    refPrefix: '#',
    refPaths: { issue: (number) => `/issues/${number}`, changeRequest: (number) => `/pulls/${number}` },
    identityIcon: 'github',
    normalizeInstance: normalizeGitHubInstance,
    providerUserId: (_instance, user) => `github.com#${user.id}`,
  }),
  gitlab: Object.freeze({
    id: 'gitlab',
    label: 'GitLab',
    defaultInstance: 'https://gitlab.com',
    bareInstance: false,
    refPrefix: '!',
    refPaths: { issue: (number) => `/-/issues/${number}`, changeRequest: (number) => `/-/merge_requests/${number}` },
    identityIcon: 'gitlab',
    normalizeInstance: normalizeGitLabInstance,
    providerUserId: (instance, user) => `${instance}#${user.id}`,
  }),
  gitea: Object.freeze({
    id: 'gitea',
    label: 'Gitea',
    defaultInstance: null,
    bareInstance: false,
    refPrefix: '#',
    refPaths: { issue: (number) => `/issues/${number}`, changeRequest: (number) => `/pulls/${number}` },
    identityIcon: 'gitea',
    normalizeInstance: normalizeGiteaInstance,
    providerUserId: (instance, user) => `${instance}#${user.id}`,
  }),
});

export const providerTraits = (provider) => {
  const traits = PROVIDER_TRAITS[provider];
  if (!traits) throw new Error('Source control provider is unsupported');
  return traits;
};

export const normalizeSourceControlProviderInstance = (provider, instance) =>
  providerTraits(provider).normalizeInstance(instance);

export const isNormalizedProviderInstance = (provider, instance) => {
  try {
    return normalizeSourceControlProviderInstance(provider, instance) === instance;
  } catch {
    return false;
  }
};

export const providerOrigin = (provider, instance) => {
  const traits = providerTraits(provider);
  const normalized = traits.normalizeInstance(instance);
  return new URL(traits.bareInstance ? `https://${normalized}` : normalized);
};

export const providerUserIdFor = (provider, instance, user) =>
  providerTraits(provider).providerUserId(instance, user);

export const matchesProviderUserId = (provider, instance, providerUserId) => {
  if (provider === 'github') return /^github\.com#\d+$/.test(providerUserId);
  return isString(providerUserId)
    && providerUserId.startsWith(`${instance}#`)
    && /^\d+$/.test(providerUserId.slice(instance.length + 1));
};

export const providerCredentialSecret = (provider, account) =>
  provider === 'github' ? account?.accessToken : account?.token;

export const providerCredentialUsername = (provider, account) => {
  if (provider === 'github') return 'x-access-token';
  if (provider === 'gitlab') return 'oauth2';
  return account?.user?.login ?? 'git';
};

/** Provider accepted by the contract, but its module is not wired up yet. */
export const unsupportedProviderError = (provider) => Object.assign(
  new Error(`Source control provider ${provider} is not available`),
  { code: 'UNSUPPORTED_SOURCE_CONTROL_PROVIDER', status: 501 },
);
