import { opencodeClient } from '@/lib/opencode/client';
import { findMessagePageItem } from '@/lib/opencode/messagePaging';
import type { FilePart, Part } from '@/lib/opencode/model';
import { flattenAssistantTextParts, flattenUserTextParts } from '@/lib/messages/messageText';
import { getGitStatus } from '@/lib/gitApi';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { structuredErrorText } from '@/lib/opencode/projection';

export type LanePrompt = {
  messageId: string;
  text: string;
  files: Array<{ mime: string; filename?: string; url: string }>;
};

export type LaneDiffStat = {
  files: number;
  insertions: number;
  deletions: number;
};

const isFilePart = (part: Part): part is FilePart => part.type === 'file';

export async function loadLaneFirstPrompt(sessionId: string, directory: string): Promise<LanePrompt | null> {
  const first = await findMessagePageItem(sessionId, (item) => item.info.role === 'user', { limit: 10, order: 'asc' }, directory);
  if (!first) return null;
  return {
    messageId: first.info.id,
    text: flattenUserTextParts(first.parts),
    files: first.parts.filter(isFilePart).map((part) => ({ mime: part.mime, filename: part.filename, url: part.url })),
  };
}

export type LaneLastTurn = {
  text: string;
  error: string | null;
};

export async function loadLaneLastTurn(sessionId: string, directory: string): Promise<LaneLastTurn> {
  const page = await opencodeClient.getSessionMessages(sessionId, { limit: 50 }, directory);
  let error: string | null = null;
  for (const record of page.items) {
    if (record.info.role !== 'assistant') continue;
    if (error === null && record.info.error) error = structuredErrorText(record.info.error).trim() || null;
    const text = flattenAssistantTextParts(record.parts).trim();
    if (text) return { text, error };
  }
  return { text: '', error };
}

export async function loadLaneLastReply(sessionId: string, directory: string): Promise<string> {
  return (await loadLaneLastTurn(sessionId, directory)).text;
}

export async function loadLaneDiffStat(directory: string): Promise<LaneDiffStat> {
  const status = await getGitStatus(directory);
  let insertions = 0;
  let deletions = 0;
  for (const scope of [status.diffStats?.staged, status.diffStats?.working]) {
    for (const stat of Object.values(scope ?? {})) {
      insertions += stat.insertions;
      deletions += stat.deletions;
    }
  }
  return { files: status.files.length, insertions, deletions };
}

type CachedValue<T> = { token: string; value: T };

export function createLaneCache<T>(limit = 200) {
  const entries = new Map<string, CachedValue<T>>();
  return {
    tokenFor(sessionId: string, revision: number | string | undefined): string {
      return `${getRuntimeKey()}\u0000${sessionId}\u0000${revision ?? ''}`;
    },
    get(sessionId: string, token: string): T | undefined {
      const cached = entries.get(sessionId);
      return cached && cached.token === token ? cached.value : undefined;
    },
    set(sessionId: string, token: string, value: T): void {
      entries.delete(sessionId);
      entries.set(sessionId, { token, value });
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}
