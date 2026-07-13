import { useEffect, useRef } from 'react';
import type { ChatMessageEntry } from '../lib/turns/types';
import { useChatSearchStore } from '@/stores/useChatSearchStore';
import type { MatchRecord } from '@/stores/useChatSearchStore';
import { buildSearchRegex } from '@/lib/splitByHighlight';
import { getSearchablePartId } from './chatSearchPartIdentity';
import { getSearchablePartType } from './useChatSearchContext';
import { stripMarkdownForSearch } from './chatSearchNormalization';

// ── text extraction helpers ───────────────────────────────────────────────────

/**
 * Picks the longest non-empty text field from a part.
 * Mirrors the logic in AssistantTextPart and UserTextPart.
 */
function getBestPartText(part: Record<string, unknown>): string {
  const candidates = [
    typeof part.text === 'string' ? part.text : '',
    typeof part.content === 'string' ? part.content : '',
    typeof part.value === 'string' ? part.value : '',
  ];
  return candidates.reduce((best, c) => (c.length > best.length ? c : best), '');
}

/**
 * Normalises raw markdown text to match what the rehype render layer presents:
 *
 * - Fenced code blocks     → single space   (inside <pre>, skipped by rehype)
 * - Inline code backticks  → stripped, content kept  (`foo` → foo)
 * - Bold markers stripped  (**text** → text, __text__ → text)
 * - Italic markers stripped (*text* → text, _text_ → text)
 * - Strikethrough stripped (~~text~~ → text)
 * - Links collapsed         ([label](url) → label)
 * - Images collapsed        (![alt](url) → alt)
 *
 * This ensures "hello world" matches "hello **world**" in the data layer,
 * consistent with the cross-boundary highlighting the DOM produces.
 */
export { stripMarkdownForSearch } from './chatSearchNormalization';

// ── hook ─────────────────────────────────────────────────────────────────────

/**
 * Scans loaded messages for matches against the current search query and
 * writes the result to the store via `setMatches`.
 *
 * Debounced 350 ms to avoid hammering during streaming.  The dependency on
 * `messages` means the effect re-runs (and the timer resets) whenever message
 * content changes — so counts stay accurate after streaming finalises.
 *
 * Call this once in ChatContainer and pass the full `sessionMessages` array
 * (not `timelineController.renderedMessages`, which is windowed and excludes
 * messages behind the "Load older messages" button).
 */
export function useChatSearchMatcher(messages: ChatMessageEntry[]): void {
  const isOpen = useChatSearchStore((s) => s.isOpen);
  const query = useChatSearchStore((s) => s.query);
  const caseSensitive = useChatSearchStore((s) => s.flags.caseSensitive);
  const wholeWord = useChatSearchStore((s) => s.flags.wholeWord);
  const isRegex = useChatSearchStore((s) => s.flags.regex);
  const includeThinking = useChatSearchStore((s) => s.flags.includeThinking ?? false);

  // Keep a stable ref to the latest messages so the timer callback always
  // sees the most recent data even if it was queued before the last update.
  const messagesRef = useRef(messages);
  const searchSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    messagesRef.current = messages;
  });

  useEffect(() => {
    if (!isOpen || !query) {
      useChatSearchStore.getState().setMatches([], null);
      searchSignatureRef.current = null;
      return;
    }

    const searchSignature = JSON.stringify({ query, caseSensitive, wholeWord, isRegex, includeThinking });
    const preserveActiveMatch = searchSignatureRef.current === searchSignature;
    searchSignatureRef.current = searchSignature;

    const timer = setTimeout(() => {
      const regex = buildSearchRegex(query, { caseSensitive, wholeWord, regex: isRegex, includeThinking });
      if (!regex) {
        useChatSearchStore.getState().setMatches([], null);
        return;
      }

      const newMatches: MatchRecord[] = [];

      for (const message of messagesRef.current) {
        message.parts.forEach((part, partIndex) => {
          const partType = getSearchablePartType(part);
          if (!partType || (partType === 'reasoning' && !includeThinking)) {
            return;
          }

          const raw = getBestPartText(part as unknown as Record<string, unknown>);
          const text = stripMarkdownForSearch(raw);
          if (!text) {
            return;
          }

          regex.lastIndex = 0;
          let occurrenceInPart = 0;
          let match: RegExpExecArray | null;
          while ((match = regex.exec(text)) !== null) {
            if (match[0].length === 0) {
              regex.lastIndex += 1;
              continue;
            }
            newMatches.push({
              messageId: message.info.id,
              partId: getSearchablePartId(message.info.id, part, partIndex),
              partType,
              occurrenceInPart: occurrenceInPart++,
            });
          }
        });
      }

      // Preserve the user's position when the same logical part occurrence is
      // still present. Query/flag changes deliberately reset to the first hit.
      const { matches: prevMatches, activeIndex } = useChatSearchStore.getState();
      const currentMatch = preserveActiveMatch ? prevMatches[activeIndex] ?? null : null;
      useChatSearchStore.getState().setMatches(newMatches, currentMatch);
    }, 350);

    return () => clearTimeout(timer);
  }, [
    isOpen,
    query,
    caseSensitive,
    wholeWord,
    isRegex,
    includeThinking,
    // Re-run when messages change (new message, streaming finalize, load older).
    // Using the array reference is intentional: it resets the debounce timer
    // on each update, so the matcher runs 350 ms after the last change.
    messages,
  ]);
}
