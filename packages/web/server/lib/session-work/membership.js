import path from 'path';
import { z } from 'zod';
import { isPinnedMetadata, readWork } from './state.js';
import { sessionParentId } from '../session-lineage.js';

const notWorkSessionSchema = z.object({ openchamber: z.object({ kind: z.enum(['review', 'btw', 'scheduled']) }) });

const sessionDirectory = (session) => session?.location?.directory ?? session?.directory;

export const createWorkMembership = ({ chatRoots = [] } = {}) => {
  const resolvedChatRoots = chatRoots.filter(Boolean).map((root) => path.resolve(root));
  const isChatDirectory = (directory) => {
    if (!directory) return false;
    const resolved = path.resolve(directory);
    return resolvedChatRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  };

  const canBeInWork = (session) => Boolean(session)
    && !sessionParentId(session)
    && !isChatDirectory(sessionDirectory(session))
    && !notWorkSessionSchema.safeParse(session.metadata).success;

  const isInWork = (session) => Boolean(session)
    && !sessionParentId(session)
    && !session.time?.archived
    && !isChatDirectory(sessionDirectory(session))
    && !isPinnedMetadata(session.metadata)
    && readWork(session.metadata)?.state === 'open';

  const isDoneSuggested = (session) => {
    const suggestedAt = readWork(session?.metadata)?.suggestDoneAt;
    return isInWork(session) && suggestedAt !== undefined && suggestedAt >= (session.time?.idle ?? 0);
  };

  return { isChatDirectory, canBeInWork, isInWork, isDoneSuggested };
};
