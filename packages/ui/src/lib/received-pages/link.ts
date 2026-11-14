/**
 * A share link someone sent the user: `<relay base>/p/<22-char id>#<32-byte
 * base64url key>`. Only links on a relay the server opens (its `config`
 * bases) are taken; the server checks again before it keeps one.
 */
export type FoundShareLink = { start: number; end: number; url: string; host: string; shareId: string };

const SHARE_LINK = /https:\/\/[^\s<>"'`()]+?\/p\/([A-Za-z0-9_-]{22})#[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

const SHARE_LINK_KEY = /(https?:\/\/[^\s<>"'`()]+?\/p\/[A-Za-z0-9_-]{22})#[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

/**
 * `text` with the key cut from every share link in it, on any host: what is
 * sent, queued or saved as a draft never carries one, whichever way a link
 * got past the composer (a host this server does not open, a restored
 * draft, VS Code). The link without its key opens nothing.
 */
export const withoutShareLinkKeys = (text: string): string => (text.includes('/p/') ? text.replace(SHARE_LINK_KEY, '$1') : text);

/** The first whole share link in `text` on one of `bases`, or null. A key still being typed is not whole. */
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
