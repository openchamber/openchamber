/** The REST API root for github.com, Enterprise Cloud data residency, or Enterprise Server. */
export function gitHubApiBaseUrl(host) {
  const instance = String(host ?? '').trim().toLowerCase() || 'github.com';
  if (instance === 'github.com') return 'https://api.github.com';
  if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com$/.test(instance)) return `https://api.${instance}`;
  return `https://${instance}/api/v3`;
}

/** Only a data-residency API hostname maps back to a different instance hostname. */
export function gitHubInstanceFromApiHost(host) {
  const normalized = String(host ?? '').trim().toLowerCase();
  if (normalized === 'api.github.com') return 'github.com';
  const cloud = normalized.match(/^api\.([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com)$/);
  return cloud ? cloud[1] : normalized;
}

/** Parse a repository URL from the API belonging to the account that made the request. */
export function gitHubRepositoryFromApiUrl(value, host) {
  const parsed = z.string().safeParse(value);
  if (!parsed.success) return null;
  try {
    const url = new URL(parsed.data);
    const base = new URL(gitHubApiBaseUrl(host));
    if (url.origin !== base.origin || url.username || url.password || url.search || url.hash) return null;
    const prefix = `${base.pathname.replace(/\/$/, '')}/repos/`;
    if (!url.pathname.startsWith(prefix)) return null;
    const parts = url.pathname.slice(prefix.length).split('/');
    return parts.length === 2 && parts.every(Boolean) ? { owner: parts[0], repo: parts[1] } : null;
  } catch {
    return null;
  }
}
import { z } from 'zod';
