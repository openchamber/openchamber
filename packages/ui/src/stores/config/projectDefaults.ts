import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useConfigStore } from '../useConfigStore';
import { normalizeConfigPath, toDirectoryKey } from './directories';
import { normalizeOptionalString } from './selectionResolution';
import { resolveProjectDirectory } from './worktreeProjects';

export const getFallbackProjectDirectory = (): string | null => {
    try {
        const { projects, activeProjectId } = useProjectsStore.getState();
        const active = activeProjectId
            ? projects.find((project) => project.id === activeProjectId)
            : null;
        return normalizeConfigPath(active?.path ?? projects[0]?.path ?? null);
    } catch {
        return null;
    }
};

type ProjectDefaults = { projectDefaultAgent?: string; projectDefaultModel?: string; projectDefaultVariant?: string };

export const isChatDraftOpen = (): boolean => {
    const session = useSessionUIStore.getState();
    return !session.currentSessionId && Boolean(session.newSessionDraft?.open) && session.newSessionDraft.target === 'chat';
};

export const getProjectDefaultsForConfigDirectory = (directory: string | null | undefined): ProjectDefaults => {
    const configDirectory = normalizeConfigPath(directory);
    if (isChatDraftOpen() && (!configDirectory || toDirectoryKey(configDirectory) === useConfigStore.getState().activeDirectoryKey)) return readChatDefaults();
    if (!configDirectory) {
        return {};
    }
    return readScopeDefaults(configDirectory);
};

export const readScopeDefaults = (configDirectory: string): ProjectDefaults => (
    isChatDirectoryPath(configDirectory) ? readChatDefaults() : readProjectDefaults(configDirectory)
);

const readChatDefaults = (): ProjectDefaults => {
    const { chatsDefaultAgent, chatsDefaultModel, chatsDefaultVariant } = useConfigStore.getState();
    return { projectDefaultAgent: chatsDefaultAgent, projectDefaultModel: chatsDefaultModel, projectDefaultVariant: chatsDefaultVariant };
};

const readProjectDefaults = (configDirectory: string): ProjectDefaults => {
    const projectDirectory = resolveProjectDirectory(configDirectory);
    const project = useProjectsStore.getState().projects.find((entry) => normalizeConfigPath(entry.path) === projectDirectory);
    return {
        projectDefaultAgent: normalizeOptionalString(project?.defaultAgent),
        projectDefaultModel: normalizeOptionalString(project?.defaultModel),
        projectDefaultVariant: normalizeOptionalString(project?.defaultVariant),
    };
};
