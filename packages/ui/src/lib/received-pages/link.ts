export type FoundShareLink = { start: number; end: number; url: string; host: string; shareId: string };

const SHARE_LINK = /https:\/\/[^\s<>"'`()]+?\/p\/([A-Za-z0-9_-]{22})#[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

const SHARE_LINK_KEY = /(https?:\/\/[^\s<>"'`()]+?\/p\/[A-Za-z0-9_-]{22})#[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

export const withoutShareLinkKeys = (text: string): string => (text.includes('/p/') ? text.replace(SHARE_LINK_KEY, '$1') : text);

export function findShareLink(text: string, bases: readonly string[]): FoundShareLink | null {
  if (bases.length === 0 || !text.includes('/p/')) return null;
  for (const match of text.matchAll(SHARE_LINK)) {
    const url = match[0];
    const base = url.slice(0, url.lastIndexOf('/p/'));
    if (!bases.includes(base)) continue;
    const start = match.index;
    return { start, end: start + url.length, url, host: new URL(url).host, shareId: match[1] };
  }
  return null;
}
