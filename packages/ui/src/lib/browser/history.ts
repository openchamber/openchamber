/**
 * Address history for the browser panel.
 *
 * The panel is used to return to the same handful of addresses — a dev server,
 * a staging URL, one page of the app being worked on — so typing them out every
 * time is the wrong default. History is per project, because the addresses that
 * matter belong to whatever is being worked on, not to the app as a whole.
 *
 * The ranking and matching live here as pure functions so the behaviour can be
 * reasoned about without a store, a list, or a keyboard in the way.
 */
import { normalizeBrowserUrl } from './url';

export type BrowserHistoryEntry = {
  readonly url: string;
  readonly title: string;
  readonly lastVisitedAt: number;
};

/** Enough to cover a project's real addresses without becoming a list nobody reads. */
export const MAX_HISTORY_ENTRIES = 50;
const MAX_HISTORY_SUGGESTIONS = 6;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 200;

/**
 * The stored form of an address.
 *
 * Returns '' for anything that is not a page worth remembering. `about:blank`
 * is the view's resting state, and a data URL is a document with no address to
 * return to.
 */
export const historyUrl = (value: string): string => {
  const normalized = normalizeBrowserUrl(String(value ?? '').trim());
  if (!normalized || normalized.length > MAX_URL_LENGTH) return '';
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch {
    return '';
  }
};

/**
 * Records a visit, newest first.
 *
 * Revisiting an address moves it up rather than adding a second copy — the list
 * is places, not events. A visit with no title keeps the title already known,
 * because a page often reports its address before it reports its name.
 */
export const recordVisit = (
  entries: readonly BrowserHistoryEntry[],
  visit: { url: string; title?: string; at: number },
): BrowserHistoryEntry[] => {
  const url = historyUrl(visit.url);
  if (!url) return entries as BrowserHistoryEntry[];

  const previous = entries.find((entry) => entry.url === url);
  const title = String(visit.title ?? '').trim().slice(0, MAX_TITLE_LENGTH) || previous?.title || '';
  const next: BrowserHistoryEntry = { url, title, lastVisitedAt: visit.at };

  return [next, ...entries.filter((entry) => entry.url !== url)].slice(0, MAX_HISTORY_ENTRIES);
};

export const forgetVisit = (
  entries: readonly BrowserHistoryEntry[],
  url: string,
): BrowserHistoryEntry[] => {
  const target = historyUrl(url);
  return entries.filter((entry) => entry.url !== target);
};

/** What a query matches against: the address without its scheme, plus the title. */
const searchableText = (entry: BrowserHistoryEntry): string => (
  `${entry.url.replace(/^https?:\/\//, '')} ${entry.title}`.toLowerCase()
);

/**
 * Suggests addresses for what has been typed so far.
 *
 * An empty query offers the most recent addresses, which is what an empty
 * address bar is asking for. A query matches anywhere in the address or title,
 * since a port or a path fragment is often all anyone remembers.
 */
export const suggestFromHistory = (
  entries: readonly BrowserHistoryEntry[],
  query: string,
  limit = MAX_HISTORY_SUGGESTIONS,
): BrowserHistoryEntry[] => {
  const needle = String(query ?? '').trim().toLowerCase();
  const ordered = [...entries].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt);
  if (!needle) return ordered.slice(0, limit);

  const scheme = needle.replace(/^https?:\/\//, '');
  return ordered
    .filter((entry) => {
      const text = searchableText(entry);
      // An address the user has fully typed is not a suggestion, it is what
      // they already have; offering it back is noise.
      if (entry.url === needle || text === scheme) return false;
      return text.includes(scheme);
    })
    .slice(0, limit);
};
