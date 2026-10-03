import { normalizeGitLabInstance } from '../gitlab/instance.js';

const isString = (value) => Object.prototype.toString.call(value) === '[object String]';

export function normalizeSourceControlProviderInstance(provider, instance) {
  const value = isString(instance) ? instance.trim() : '';
  if (!value) throw new Error('Source control provider instance is required');
  if (provider === 'gitlab') return normalizeGitLabInstance(value);
  if (provider !== 'github') throw new Error('Source control provider is unsupported');

  let host = value.toLowerCase().replace(/\.$/, '');
  if (host.includes('://')) {
    const url = new URL(host);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || (url.pathname && url.pathname !== '/')) throw new Error('GitHub instance must be an HTTPS origin');
    host = url.hostname.toLowerCase().replace(/\.$/, '');
  }
  if (host !== 'github.com') throw new Error('GitHub instance is unsupported');
  return 'github.com';
}
