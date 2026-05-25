import { useEffect, useRef } from 'react';
import type { ChatMessageEntry } from '../lib/turns/types';
import { useChatSearchStore } from '@/stores/useChatSearchStore';
import type { MatchRecord } from '@/stores/useChatSearchStore';
import { buildSearchRegex } from '@/lib/splitByHighlight';

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
 * Strips fenced code blocks (```...```) and inline code (`...`) from markdown
 * text so the data-layer match count mirrors what the rehype plugin highlights
 * (which skips <code> and <pre> elements).
 */
function stripMarkdownCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gm, ' ')
    .replace(/`[^`\n]+`/g, ' ');
}

/**
 * Returns the combined searchable text for a message, consistent with what
 * the rendering layer will actually mark up in the DOM:
 *
 * Searches user/assistant text and reasoning parts (code blocks stripped).
 *
 * Keeping this consistent with what the DOM highlights is critical so that
 * data-layer match count equals DOM mark count within each message.
 */
function getSearchableText(message: ChatMessageEntry): string {
  const texts: string[] = [];

  for (const part of message.parts) {
    const p = part as unknown as Record<string, unknown>;
    if (p.type === 'text' || p.type === 'reasoning') {
      const raw = getBestPartText(p);
      if (raw) texts.push(stripMarkdownCode(raw));
    }
  }

  return texts.join('\n');
}

// ── hook ─────────────────────────────────────────────────────────────────────

/**
 * Scans loaded messages for matches against the current search query and
 * writes the result to the store via `setMatches`.
 *
 * Debounced 350 ms to avoid hammering during streaming.  The dependency on
 * `messages` means the effect re-runs (and the timer resets) whenever message
 * content changes — so counts stay accurate after streaming finalises.
 *
 * Call this once in ChatContainer and pass `timelineController.renderedMessages`.
 */
export function useChatSearchMatcher(messages: ChatMessageEntry[]): void {
  const isOpen = useChatSearchStore((s) => s.isOpen);
  const query = useChatSearchStore((s) => s.query);
  const caseSensitive = useChatSearchStore((s) => s.flags.caseSensitive);
  const wholeWord = useChatSearchStore((s) => s.flags.wholeWord);
  const isRegex = useChatSearchStore((s) => s.flags.regex);

  // Keep a stable ref to the latest messages so the timer callback always
  // sees the most recent data even if it was queued before the last update.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  });

  useEffect(() => {
    if (!isOpen || !query) {
      useChatSearchStore.getState().setMatches([]);
      return;
    }

    const timer = setTimeout(() => {
      const regex = buildSearchRegex(query, { caseSensitive, wholeWord, regex: isRegex });
      if (!regex) {
        useChatSearchStore.getState().setMatches([]);
        return;
      }

      const newMatches: MatchRecord[] = [];

      for (const message of messagesRef.current) {
        const text = getSearchableText(message);
        if (!text) continue;

        regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(text)) !== null) {
          if (m[0].length === 0) {
            regex.lastIndex++;
            continue;
          }
          newMatches.push({ messageId: message.info.id });
        }
      }

      useChatSearchStore.getState().setMatches(newMatches);
    }, 350);

    return () => clearTimeout(timer);
  }, [
    isOpen,
    query,
    caseSensitive,
    wholeWord,
    isRegex,
    // Re-run when messages change (new message, streaming finalize, load older).
    // Using the array reference is intentional: it resets the debounce timer
    // on each update, so the matcher runs 350 ms after the last change.
    messages,
  ]);
}
