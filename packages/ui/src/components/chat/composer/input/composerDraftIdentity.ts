import { useSessionUIStore, type NewSessionDraftState } from '@/sync/session-ui-store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createChatDraftIdentity, workDraftComposerKey, workDraftKeepsOwnSlot, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { type ChatColumnSession } from '../../chatColumnSession';
import { getSettingsSurface } from '@/lib/settings/surface';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

export const NEW_CHAT_DRAFT_DIRECTORY = CHAT_DRAFT_PROJECT_ID;

export const resolveWorkDraftComposerKey = (draft: NewSessionDraftState | null | undefined): string | null => {
    return draft?.open && (draft.target === 'project' || workDraftKeepsOwnSlot(draft.workDraftId)) && draft.workDraftId && getSettingsSurface() !== 'vscode'
        ? workDraftComposerKey(draft.workDraftId)
        : null;
};

const newSessionDraftDirectory = (draft: NewSessionDraftState | null | undefined): string | null => (
    draft?.open
        ? draft.target === 'chat' ? NEW_CHAT_DRAFT_DIRECTORY : draft.bootstrapPendingDirectory ?? draft.directoryOverride ?? null
        : null
);

export const resolveOpenWorkDraftIdentity = (workDraftId: string, runtimeKey: string): ChatDraftIdentity | null => {
    const draft = useSessionUIStore.getState().newSessionDraft;
    if (!draft?.open || draft.workDraftId !== workDraftId) return null;
    const composerKey = resolveWorkDraftComposerKey(draft);
    return composerKey ? createChatDraftIdentity(runtimeKey, newSessionDraftDirectory(draft), composerKey) : null;
};

export const resolveChatDraftIdentity = (column: ChatColumnSession | null): ChatDraftIdentity | null => {
    const sessionState = useSessionUIStore.getState();
    const sessionId = column ? column.sessionId : sessionState.currentSessionId;
    const draft = sessionState.newSessionDraft;
    const newSessionDirectory = newSessionDraftDirectory(draft);
    const directory = sessionId
        ? sessionState.getDirectoryForSession(sessionId) ?? (column ? column.directory : sessionState.currentSessionDirectory)
        : newSessionDirectory ?? useDirectoryStore.getState().currentDirectory;
    return createChatDraftIdentity(getRuntimeKey(), directory, sessionId ?? resolveWorkDraftComposerKey(draft));
};
