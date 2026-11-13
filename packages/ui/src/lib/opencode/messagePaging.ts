import { opencodeClient, type MessagePage } from './client';
import type { Message, Part } from './model';

export type MessagePageItem = { info: Message; parts: Part[] };

export type FindMessagePageItemOptions = {
  /** Page size, when the caller needs a specific window. */
  limit?: number;
  /** Page order, when the caller needs oldest-first. */
  order?: 'asc' | 'desc';
};

/**
 * Finds the first record matching `matches` by walking the session's message
 * cursor pages until it appears or the history runs out.
 *
 * A single page is never the whole history: OpenCode interleaves plumbing
 * roles with conversation records, and a busy session pushes an older target
 * past any fixed window. A repeated cursor ends the walk so a server that
 * echoes the same `next` cannot loop forever.
 */
export async function findMessagePageItem(
  sessionId: string,
  matches: (item: MessagePageItem) => boolean,
  options: FindMessagePageItemOptions = {},
  directory?: string | null,
): Promise<MessagePageItem | null> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page: MessagePage = await opencodeClient.getSessionMessages(
      sessionId,
      cursor ? { cursor } : { limit: options.limit, order: options.order },
      directory,
    );
    const found = page.items.find(matches);
    if (found) return found;
    const next = page.cursor.next;
    if (!next || seenCursors.has(next)) return null;
    seenCursors.add(next);
    cursor = next;
  }
}
