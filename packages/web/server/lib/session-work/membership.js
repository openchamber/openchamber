/**
 * Which sessions In work serves and which ones it shows, for the runtime
 * that opens sessions and for the agent tool that lists and closes them.
 */
import path from 'path';
import { z } from 'zod';
import { isPinnedMetadata, readWork } from './state.js';

/**
 * Sessions that are not the user's own work: a review of another session, a
 * `/btw` side question forked off one, a run of a scheduled task.
 */
const notWorkSessionSchema = z.object({ openchamber: z.object({ kind: z.enum(['review', 'btw', 'scheduled']) }) });

const sessionDirectory = (session) => session?.location?.directory ?? session?.directory;

/** `chatRoots`: roots of managed Chats, plain conversations that are never work. */
export const createWorkMembership = ({ chatRoots = [] } = {}) => {
  const resolvedChatRoots = chatRoots.filter(Boolean).map((root) => path.resolve(root));
  const isChatDirectory = (directory) => {
    if (!directory) return false;
    const resolved = path.resolve(directory);
    return resolvedChatRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  };

  /** A top-level project session that is not a review, a `/btw` question or a scheduled run; archived or not. */
  const canBeInWork = (session) => Boolean(session)
    && !session.parentID
    && !isChatDirectory(sessionDirectory(session))
    && !notWorkSessionSchema.safeParse(session.metadata).success;

  /**
   * Whether the sidebar's In work block shows the session
   * (`orderInWorkWorks` in packages/ui): top level, not archived, not a Chat,
   * not pinned, open.
   */
  const isInWork = (session) => Boolean(session)
    && !session.parentID
    && !session.time?.archived
    && !isChatDirectory(sessionDirectory(session))
    && !isPinnedMetadata(session.metadata)
    && readWork(session.metadata)?.state === 'open';

  /**
   * Jev's "looks done" hint, while it is current: written after the last turn
   * ended (`isDoneSuggested` in packages/ui).
   */
  const isDoneSuggested = (session) => {
    const suggestedAt = readWork(session?.metadata)?.suggestDoneAt;
    // `readWork` already checked it is a number.
    return isInWork(session) && suggestedAt !== undefined && suggestedAt >= (session.time?.idle ?? 0);
  };

  return { isChatDirectory, canBeInWork, isInWork, isDoneSuggested };
};
