import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isSessionDirectoryAdmitted } from '@/sync/session-admission-rule';
import { useSession } from '@/sync/sync-context';
import { ensureSpaceArchives, useSpaceArchiveOf } from '@/lib/spaces/space-archives';
import { resolveChatPromptReadOnly } from '../chatPromptReadOnly';
import { useEndMessageSelectionOnLeave } from '@/hooks/useMessageSelectionLifetime';
import { useMessageSelecting } from '@/stores/useMessageSelectionStore';

/** Whether the shown session takes prompts, and whether the user is picking messages in it. */
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
    const currentSession = useSession(currentSessionId, effectiveSessionDirectory);
    // A chat of a deleted isolated space is on the Archive page and read-only; the server refuses
    // to run it whatever the screen shows. Its directory is the archive's own, and the list of
    // archives is read once per runtime. A draft opened after such a chat still sits in the
    // archive's directory until it is sent, and is not read-only: it is a new chat.
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
