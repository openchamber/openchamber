
import { MIN_QUERY_TERM_LENGTH } from '@/lib/messageSearch';

const SEARCH_HIGHLIGHT = 'oc-chat-search';
const SEARCH_CURRENT_HIGHLIGHT = 'oc-chat-search-current';

const SEARCHABLE_TEXT_SELECTOR = '[data-user-message-bubble], [data-markdown-content]';

const supportsSearchHighlights = (): boolean => 'Highlight' in window && 'highlights' in CSS;

export const toHighlightTerms = (query: string): string[] => query
  .trim()
  .split(/\s+/)
  .filter((term) => Array.from(term).length >= MIN_QUERY_TERM_LENGTH)
  .map((term) => term.toLowerCase());

export const findTermRanges = (messageRoot: Element, terms: readonly string[]): Range[] => {
  const ranges: Range[] = [];
  if (terms.length === 0) return ranges;
  const document = messageRoot.ownerDocument;
  const ownId = messageRoot.getAttribute('data-message-id');
  for (const container of messageRoot.querySelectorAll(SEARCHABLE_TEXT_SELECTOR)) {
    if (messageRoot.contains(container.parentElement?.closest(SEARCHABLE_TEXT_SELECTOR) ?? null)) continue;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (ownId !== null && node.parentElement?.closest('[data-message-id]') !== messageRoot) continue;
      if (ownId !== null && messageRoot.contains(node.parentElement?.closest('[data-reasoning-message-id]') ?? null)) continue;
      const text = node.nodeValue ?? '';
      const lower = text.toLowerCase();
      if (lower.length !== text.length) continue;
      const found: [number, number][] = [];
      for (const term of terms) {
        for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) found.push([at, at + term.length]);
      }
      found.sort((left, right) => left[0] - right[0]);
      for (const [start, end] of found) {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        ranges.push(range);
      }
    }
  }
  return ranges;
};

export const paintSearchHighlights = (all: Range[], current: Range[]): void => {
  if (!supportsSearchHighlights()) return;
  if (all.length > 0) CSS.highlights.set(SEARCH_HIGHLIGHT, new Highlight(...all));
  else CSS.highlights.delete(SEARCH_HIGHLIGHT);
  if (current.length > 0) {
    const highlight = new Highlight(...current);
    highlight.priority = 1;
    CSS.highlights.set(SEARCH_CURRENT_HIGHLIGHT, highlight);
  } else {
    CSS.highlights.delete(SEARCH_CURRENT_HIGHLIGHT);
  }
};
