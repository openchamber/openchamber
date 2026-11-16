import { opencodeClient, type MessagePage } from './client';
import type { Message, Part } from './model';

export type MessagePageItem = { info: Message; parts: Part[] };

export type FindMessagePageItemOptions = {
  limit?: number;
  order?: 'asc' | 'desc';
};

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
