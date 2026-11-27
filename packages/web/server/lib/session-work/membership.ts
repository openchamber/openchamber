import path from 'path';
import { z } from 'zod';
import { isPinnedMetadata, readWork } from './state.js';
import { sessionParentId } from '../session-lineage.js';
import type { SessionMetadata } from '@opencode/client';

export interface WorkSession {
  parentID?: string | null;
  location?: { directory: string };
  directory?: string;
  metadata?: SessionMetadata;
  time?: { archived?: number; idle?: number };
}

const notWorkSessionSchema = z.object({ openchamber: z.object({ kind: z.enum(['review', 'btw', 'scheduled']) }) });

const sessionDirectory = (session: WorkSession | null | undefined) => session?.location?.directory ?? session?.directory;

export const createWorkMembership = ({ chatRoots = [] }: { chatRoots?: string[] } = {}) => {
  const resolvedChatRoots = chatRoots.filter(Boolean).map((root) => path.resolve(root));
  const isChatDirectory = (directory: string | null | undefined) => {
    if (!directory) return false;
    const resolved = path.resolve(directory);
    return resolvedChatRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  };

  const canBeInWork = (session: WorkSession | null | undefined) => !!session
    && !sessionParentId(session)
    && !isChatDirectory(sessionDirectory(session))
    && !notWorkSessionSchema.safeParse(session.metadata).success;

  const isInWork = (session: WorkSession | null | undefined, pinnedInWork: boolean) => !!session
    && !sessionParentId(session)
    && !session.time?.archived
    && !isChatDirectory(sessionDirectory(session))
    && (pinnedInWork || !isPinnedMetadata(session.metadata))
    && readWork(session.metadata)?.state === 'open';

  const isDoneSuggested = (session: WorkSession | null | undefined, pinnedInWork: boolean) => {
    const suggestedAt = readWork(session?.metadata)?.suggestDoneAt;
    return isInWork(session, pinnedInWork) && suggestedAt !== undefined && suggestedAt >= (session?.time?.idle ?? 0);
  };

  return { isChatDirectory, canBeInWork, isInWork, isDoneSuggested };
};
