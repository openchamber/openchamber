import { isString } from '../shared/guards.js';
import { normalizeGitLabInstance } from '../gitlab/instance.js';

export function normalizeSourceControlProviderInstance(provider, instance) {
  const value = isString(instance) ? instance.trim() : '';
  if (!value) throw new Error('Source control provider instance is required');
  if (provider === 'gitlab') return normalizeGitLabInstance(value);
  if (provider !== 'github') throw new Error('Source control provider is unsupported');

  let host = value.toLowerCase().replace(/\.$/, '');
  if (host.includes('://')) {
    let url;
    try {
      url = new URL(host);
    } catch {
      throw new Error('GitHub instance must be an HTTPS origin');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || (url.pathname && url.pathname !== '/')) throw new Error('GitHub instance must be an HTTPS origin');
    host = url.hostname.toLowerCase().replace(/\.$/, '');
  } else if (host) {
    // A scheme-less value must form a valid origin callers can build an
    // https://<instance> URL from; one that cannot fails here with the same
    // readable error the https:// branch uses.
    let url;
    try {
      url = new URL(`https://${host}`);
    } catch {
      throw new Error('GitHub instance must be an HTTPS origin');
    }
    if (url.username || url.password || url.port || url.search || url.hash
      || (url.pathname && url.pathname !== '/')) throw new Error('GitHub instance must be an HTTPS origin');
    host = url.hostname.toLowerCase().replace(/\.$/, '');
  }
  // Any hostname is a syntactically valid GitHub instance: github.com is the
  // default, GitHub Enterprise is any other host. This module checks only the
  // form; whether a non-github.com host may actually receive a token is the
  // trust gate's call (host-trust.js), never this one.
  return host;
}
