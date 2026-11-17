// external: #4816 A message id can age past the newest page, so the read walks cursor pages until it appears or the history runs out.
import type { Part } from '@openchamber/ui/lib/opencode/model';
import type { findMessagePageItem } from '@openchamber/ui/lib/opencode/messagePaging';

export type FindPageItem = typeof findMessagePageItem;

const extractText = (parts: readonly Part[] | undefined): string => {
  if (!parts) return '';
  return parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
};

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
