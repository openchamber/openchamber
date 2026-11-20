import type { ReferenceRepo } from './contracts.js';

export const repoKey = (owner: string, repo: string) => `${owner.toLowerCase()}/${repo.toLowerCase()}`;

export function parseReferenceLookup(text: string, repos: ReferenceRepo[], kind = 'issue', host = 'github.com') {
  const trimmed = text.trim();
  const family = kind === 'discussion' ? 'discussion' : 'item';
  const hash = trimmed.match(/^#?(\d+)$/);
  if (hash) {
    return { number: Number(hash[1]), repos, family };
  }
  const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const link = parseReferenceLink(url, host, family);
  if (!link) return null;
  const target = repos.filter((entry) => repoKey(entry.owner, entry.repo) === repoKey(link.owner ?? '', link.repo ?? ''));
  return { number: link.number, repos: target, family };
}

const withoutDefaultPort = (authority: string) => authority.toLowerCase().replace(/:443$/, '');

function isSameReferenceHost(linkHost: string, host: string) {
  const link = withoutDefaultPort(linkHost);
  const connected = withoutDefaultPort(host);
  if (link === connected) return true;
  return connected === 'github.com' && link === 'www.github.com';
}

export function parseReferenceLink(text: string, host: string, family?: 'item' | 'discussion') {
  const url = text.trim().match(/^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(issues|pull|discussions)\/(\d+)(?:[/?#]\S*)?$/i);
  if (!url || !isSameReferenceHost(url[1] ?? '', host)) return null;
  if (family && (url[4]?.toLowerCase() === 'discussions') !== (family === 'discussion')) return null;
  return { owner: url[2], repo: url[3], number: Number(url[5]) };
}
