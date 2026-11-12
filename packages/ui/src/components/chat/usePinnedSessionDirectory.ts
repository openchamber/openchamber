import { normalizePath } from '@/lib/pathNormalization';
import { useSessionDirectory } from '@/sync/sync-context';
import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isSessionDirectoryAdmitted } from '@/sync/session-admission-rule';
import { getChatsRoot, subscribeChatsRoot } from '@/lib/chatDirectories';
import { useSpaceArchivesStore } from '@/lib/spaces/space-archives';

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
    const directory = !recordDirectory || normalizePath(recordDirectory) === normalizePath(openedDirectory) ? openedDirectory : recordDirectory;
    const projects = useProjectsStore((state) => state.projects);
    const worktrees = useSessionUIStore((state) => state.availableWorktreesByProject);
    // Managed roots can arrive after a pinned selection was restored.
    React.useSyncExternalStore(subscribeChatsRoot, getChatsRoot, getChatsRoot);
    useSpaceArchivesStore((state) => state.byDirectory);
    // A column only hides an unknown destination. Pins persist across
    // launches, so admitting from here would register folders nobody opened;
    // a live move is admitted by `subscribeSessionAdmission`.
    return isSessionDirectoryAdmitted(directory, projects, worktrees) ? directory : null;
};
