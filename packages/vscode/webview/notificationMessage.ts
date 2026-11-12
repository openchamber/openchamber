/**
 * Reads the assistant text a VS Code notification shows.
 *
 * A single newest-first page is not the whole history: with queued follow-ups
 * and subagent bursts the id a `message.updated` event names can age past the
 * newest page, and a fixed window then misses it and the notification's
 * `{last_message}` comes back empty. The read walks cursor pages until the id
 * appears or the history runs out (see issue #4816).
 */

import type { Part } from '@openchamber/ui/lib/opencode/model';
import type { findMessagePageItem } from '@openchamber/ui/lib/opencode/messagePaging';

/** The page walk, injected so tests can drive it without a client. */
export type FindPageItem = typeof findMessagePageItem;

const extractText = (parts: readonly Part[] | undefined): string => {
  if (!parts) return '';
  return parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
};

/**
 * The text of the assistant message a notification points at, or the newest
 * finished assistant reply when no id is given. Any read failure reads as an
 * empty string: a notification never throws.
 */
export async function fetchLastAssistantMessageText(
  findPageItem: FindPageItem,
  sessionId: string,
  messageId?: string,
): Promise<string> {
  if (!sessionId) return '';
  try {
    const target = messageId
      ? await findPageItem(sessionId, (item) => item.info.id === messageId && item.info.role === 'assistant', { limit: 5 })
      : await findPageItem(sessionId, (item) => item.info.role === 'assistant' && item.info.finish === 'stop', { limit: 5 });
    return target ? extractText(target.parts) : '';
  } catch {
    return '';
  }
}
