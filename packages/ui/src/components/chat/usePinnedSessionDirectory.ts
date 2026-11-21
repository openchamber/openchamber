import { normalizePath } from '@/lib/pathNormalization';
import { useSessionDirectory } from '@/sync/sync-context';
import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isSessionDirectoryAdmitted, resolveAdmittedLineageDirectory } from '@/sync/session-admission-rule';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { getChatsRoot, subscribeChatsRoot } from '@/lib/chatDirectories';
import { useSpaceArchivesStore } from '@/lib/spaces/space-archives';

type PinnedSelection = { sessionId: string; directory: string | null };

export const usePinnedSessionDirectory = (selection: PinnedSelection | null): string | null => {
    const recordDirectory = useSessionDirectory(selection?.sessionId);
    const openedDirectory = selection?.directory ?? null;
    const directory = !recordDirectory || normalizePath(recordDirectory) === normalizePath(openedDirectory) ? openedDirectory : recordDirectory;
    const projects = useProjectsStore((state) => state.projects);
    const worktrees = useSessionUIStore((state) => state.availableWorktreesByProject);
    React.useSyncExternalStore(subscribeChatsRoot, getChatsRoot, getChatsRoot);
    useSpaceArchivesStore((state) => state.byDirectory);
    const lineageDirectory = useGlobalSessionsStore((state) => (selection?.sessionId
        ? resolveAdmittedLineageDirectory(selection.sessionId, state.entityById, (candidate) => isSessionDirectoryAdmitted(candidate, projects, worktrees))
        : null));
    return isSessionDirectoryAdmitted(directory, projects, worktrees) ? directory : lineageDirectory;
};
