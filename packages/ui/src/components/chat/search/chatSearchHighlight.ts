// Paints the words of an in-conversation search inside the rendered messages
// with the CSS Custom Highlight API: the markdown is never touched, and a row
// the virtualized list remounts is simply painted again.

import { MIN_QUERY_TERM_LENGTH } from '@/lib/messageSearch';

const SEARCH_HIGHLIGHT = 'oc-chat-search';
const SEARCH_CURRENT_HIGHLIGHT = 'oc-chat-search-current';

// What the index holds: the user's bubble and the agent's text replies.
const SEARCHABLE_TEXT_SELECTOR = '[data-user-message-bubble], [data-markdown-content]';

// The same check the chat quote highlights make (ChatQuoteHighlightLayer).
const supportsSearchHighlights = (): boolean => 'Highlight' in window && 'highlights' in CSS;

/** The query's words the index can match: the same split the server makes. */
export const toHighlightTerms = (query: string): string[] => query
  .trim()
  .split(/\s+/)
  .filter((term) => Array.from(term).length >= MIN_QUERY_TERM_LENGTH)
  .map((term) => term.toLowerCase());

/**
 * Every occurrence of the terms in one message's searchable text. Matches are
 * found within a text node; a word split across formatting is not painted.
 */
export const findTermRanges = (messageRoot: Element, terms: readonly string[]): Range[] => {
  const ranges: Range[] = [];
  if (terms.length === 0) return ranges;
  const document = messageRoot.ownerDocument;
  for (const container of messageRoot.querySelectorAll(SEARCHABLE_TEXT_SELECTOR)) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue ?? '';
      const lower = text.toLowerCase();
      // Lowercasing that changes length (a few scripts) would shift offsets.
      if (lower.length !== text.length) continue;
      for (const term of terms) {
        for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + term.length);
          ranges.push(range);
        }
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
