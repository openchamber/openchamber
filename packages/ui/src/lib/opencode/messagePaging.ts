import { opencodeClient, type MessagePage } from './client';
import type { Message, Part } from './model';

export type MessagePageItem = { info: Message; parts: Part[] };

export type FindMessagePageItemOptions = {
  limit?: number;
  order?: 'asc' | 'desc';
};

// A server that keeps handing out fresh cursors must not keep the lookup
// paging forever; past this many pages the message counts as not found.
const FIND_MESSAGE_MAX_PAGES = 500;

export async function findMessagePageItem(
  sessionId: string,
  matches: (item: MessagePageItem) => boolean,
  options: FindMessagePageItemOptions = {},
  directory?: string | null,
): Promise<MessagePageItem | null> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pagesFetched = 0;
  for (;;) {
    const page: MessagePage = await opencodeClient.getSessionMessages(
      sessionId,
      cursor ? { cursor } : { limit: options.limit, order: options.order },
      directory,
    );
    pagesFetched += 1;
    const found = page.items.find(matches);
    if (found) return found;
    const next = page.cursor.next;
    if (!next || seenCursors.has(next)) return null;
    if (pagesFetched >= FIND_MESSAGE_MAX_PAGES) return null;
    seenCursors.add(next);
    cursor = next;
  }
}
