import { isString } from '../../shared/guards.js';
import { ProtectedMcpError } from './contract.js';

/** A browser callback may live on any HTTP host, but cannot carry credentials or a fragment. */
export function parseRedirectUri(value, field = null) {
  if (isString(value) && value.length <= 2048) {
    try {
      const url = new URL(value);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash) return url.href;
    } catch {
      // The boundary reports a stable code without echoing the submitted address.
    }
  }
  throw new ProtectedMcpError('invalid_redirect_uri', { message: field ? `invalid_redirect_uri: ${field}` : 'invalid_redirect_uri' });
}
