import { normalizePath } from '@/lib/pathNormalization';
import { useSessionDirectory } from '@/sync/sync-context';

type PinnedSelection = { sessionId: string; directory: string | null };

/**
 * The directory a pinned chat column reads its session from.
 *
 * OpenCode can move a shown session to another directory (an agent's
 * `session_move`), and `adoptSessionMove` then carries its transcript and live
 * updates to the destination's store. The column follows the session record
 * there; the directory it was opened with would keep it reading a store
 * nothing arrives in. Until the record is known, and while it names the same
 * place, the opened directory stays, so the column keeps its key. The main
 * chat follows a move through `setSessionDirectory` instead.
 */
export const usePinnedSessionDirectory = (selection: PinnedSelection | null): string | null => {
    const recordDirectory = useSessionDirectory(selection?.sessionId);
    const openedDirectory = selection?.directory ?? null;
    if (!recordDirectory || normalizePath(recordDirectory) === normalizePath(openedDirectory)) return openedDirectory;
    return recordDirectory;
};
