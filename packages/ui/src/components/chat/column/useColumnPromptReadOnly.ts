import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isSessionDirectoryAdmitted } from '@/sync/session-admission-rule';
import { useSession } from '@/sync/sync-context';
import { ensureSpaceArchives, useSpaceArchiveOf } from '@/lib/spaces/space-archives';
import { resolveChatPromptReadOnly } from '../chatPromptReadOnly';
import { useEndMessageSelectionOnLeave } from '@/hooks/useMessageSelectionLifetime';
import { useMessageSelecting } from '@/stores/useMessageSelectionStore';

export const useColumnPromptReadOnly = ({
    currentSessionId,
    effectiveSessionDirectory,
    readOnly,
}: {
    currentSessionId: string | null;
    effectiveSessionDirectory: string | undefined;
    readOnly: boolean;
}) => {
    const allowPromptingSubagentSessions = useUIStore((state) => state.allowPromptingSubagentSessions);
    const listedSession = useGlobalSessionsStore((state) => (currentSessionId ? state.entityById.get(currentSessionId) : undefined));
    const currentSession = useSession(currentSessionId, effectiveSessionDirectory) ?? listedSession;
    React.useEffect(() => {
        ensureSpaceArchives();
    }, []);
    const spaceArchive = useSpaceArchiveOf(currentSessionId ? effectiveSessionDirectory : null);
    const projects = useProjectsStore((state) => state.projects);
    const worktrees = useSessionUIStore((state) => state.availableWorktreesByProject);
    const ownDirectory = currentSession ? resolveGlobalSessionDirectory(currentSession) : null;
    const promptReadOnly = spaceArchive !== null || resolveChatPromptReadOnly(
        currentSession,
        allowPromptingSubagentSessions,
        readOnly,
        !ownDirectory || isSessionDirectoryAdmitted(ownDirectory, projects, worktrees),
    );
    const messageSelectionActive = useMessageSelecting(currentSessionId);
    useEndMessageSelectionOnLeave(currentSessionId);

    return { spaceArchive, promptReadOnly, messageSelectionActive };
};
