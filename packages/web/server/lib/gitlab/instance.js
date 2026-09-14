import { isString } from './validation.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function normalizeGitLabInstance(value) {
  const raw = isString(value) ? value.trim() : '';
  if (!raw) throw new Error('GitLab instance is required');

  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error('Invalid GitLab instance URL');
  }

  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error('GitLab instance must be an origin');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('GitLab instances must use HTTPS');
  }
  return url.origin;
}
