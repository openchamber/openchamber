import { useSessionUIStore, type NewSessionDraftState } from '@/sync/session-ui-store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createChatDraftIdentity, workDraftComposerKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { type ChatColumnSession } from '../../chatColumnSession';
import { getSettingsSurface } from '@/lib/settings/surface';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

export // A new Chat's working directory moves from the Chats root to a prepared
// folder on the first keystroke. Its composer text keys on the Chats bucket
// instead, so that move neither clears what was typed nor leaves it behind
// under the root for the next new Chat to show.
const NEW_CHAT_DRAFT_DIRECTORY = CHAT_DRAFT_PROJECT_ID;

export /**
 * The composer key of the open project draft (see `workDraftComposerKey`), or
 * null for a new Chat. The sidebars of the desktop, the web and the phone list
 * drafts; VS Code has no shared drafts, so it keeps the per-folder key, where
 * a new draft finds the text left in that folder.
 */
const resolveWorkDraftComposerKey = (draft: NewSessionDraftState | null | undefined): string | null => {
    return draft?.open && draft.target === 'project' && draft.workDraftId && getSettingsSurface() !== 'vscode'
        ? workDraftComposerKey(draft.workDraftId)
        : null;
};

export const resolveChatDraftIdentity = (column: ChatColumnSession | null): ChatDraftIdentity | null => {
    const sessionState = useSessionUIStore.getState();
    const sessionId = column ? column.sessionId : sessionState.currentSessionId;
    const draft = sessionState.newSessionDraft;
    const newSessionDirectory = draft?.open
        ? draft.target === 'chat' ? NEW_CHAT_DRAFT_DIRECTORY : draft.bootstrapPendingDirectory ?? draft.directoryOverride
        : null;
    const directory = sessionId
        ? sessionState.getDirectoryForSession(sessionId) ?? (column ? column.directory : sessionState.currentSessionDirectory)
        : newSessionDirectory ?? useDirectoryStore.getState().currentDirectory;
    return createChatDraftIdentity(getRuntimeKey(), directory, sessionId ?? resolveWorkDraftComposerKey(draft));
};