import { opencodeClient } from '@/lib/opencode/client';
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

/** The user message that started the lane, with its attachments. Null when there is none yet. */
export async function loadLaneFirstPrompt(sessionId: string, directory: string): Promise<LanePrompt | null> {
  const page = await opencodeClient.getSessionMessages(sessionId, { limit: 10, order: 'asc' }, directory);
  const first = page.items.find((record) => record.info.role === 'user');
  if (!first) return null;
  return {
    messageId: first.info.id,
    text: flattenUserTextParts(first.parts),
    files: first.parts.filter(isFilePart).map((part) => ({ mime: part.mime, filename: part.filename, url: part.url })),
  };
}

export type LaneLastTurn = {
  /** Latest assistant reply text; empty when it has not answered yet. */
  text: string;
  /** Error OpenCode recorded on the newest assistant message, if any. */
  error: string | null;
};

/** The lane's latest reply text and the error its newest step recorded. */
export async function loadLaneLastTurn(sessionId: string, directory: string): Promise<LaneLastTurn> {
  const page = await opencodeClient.getSessionMessages(sessionId, { limit: 50 }, directory);
  // v2 pages messages newest first, so the first assistant record is the last reply.
  let error: string | null = null;
  for (const record of page.items) {
    if (record.info.role !== 'assistant') continue;
    if (error === null && record.info.error) error = structuredErrorText(record.info.error).trim() || null;
    const text = flattenAssistantTextParts(record.parts).trim();
    if (text) return { text, error };
  }
  return { text: '', error };
}

/** Text of the lane's latest assistant reply; an empty string when it has not answered yet. */
export async function loadLaneLastReply(sessionId: string, directory: string): Promise<string> {
  return (await loadLaneLastTurn(sessionId, directory)).text;
}

/**
 * Uncommitted changes of a lane worktree against its HEAD: every changed path
 * counts as a file, tracked edits contribute line counts. Throws on failure,
 * so a read error is never shown as a lane without changes.
 */
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

/**
 * Tiny result cache for the overview: an entry is reused while its token
 * (runtime + session + the lane's last idle time) is unchanged, so reopening
 * the overview does not refetch finished lanes. Bounded by eviction of the
 * oldest entries.
 */
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
