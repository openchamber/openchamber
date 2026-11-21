import { normalizeBrowserUrl } from './url';

export type BrowserHistoryEntry = {
  readonly url: string;
  readonly title: string;
  readonly lastVisitedAt: number;
};

export const MAX_HISTORY_ENTRIES = 50;
const MAX_HISTORY_SUGGESTIONS = 6;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 200;

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

const searchableText = (entry: BrowserHistoryEntry): string => (
  `${entry.url.replace(/^https?:\/\//, '')} ${entry.title}`.toLowerCase()
);

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
      if (entry.url === needle || text === scheme) return false;
      return text.includes(scheme);
    })
    .slice(0, limit);
};
