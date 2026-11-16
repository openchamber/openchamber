import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useChatSessionSelection } from '../../chatColumnSession';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useSpaceProjectDirectory } from '@/lib/spaces/spaces-store';

export const useSessionProjectRef = ({
    effectiveDirectory,
    canUseProjectPlanActions,
}: {
    effectiveDirectory: string | null | undefined;
    canUseProjectPlanActions: boolean;
}) => {
    const currentSessionId = useChatSessionSelection().sessionId;
    const getDirectoryForSession = useSessionUIStore((state) => state.getDirectoryForSession);
    const projects = useProjectsStore((state) => state.projects);
    const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
    const sessionDirectory = effectiveDirectory
        ?? (currentSessionId ? getDirectoryForSession(currentSessionId) : null)
        ?? '';
    const spaceProjectDirectory = useSpaceProjectDirectory(sessionDirectory);
    const sessionProjectRef = React.useMemo(() => {
        const resolved = resolveProjectForSessionDirectory(projects, availableWorktreesByProject, sessionDirectory, spaceProjectDirectory);
        return resolved ? { id: resolved.id, path: resolved.path } : null;
    }, [availableWorktreesByProject, projects, sessionDirectory, spaceProjectDirectory]);
    const currentProjectRef = canUseProjectPlanActions ? sessionProjectRef : null;
    return { sessionProjectRef, currentProjectRef };
};
