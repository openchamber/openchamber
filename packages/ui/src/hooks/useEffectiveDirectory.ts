import { useChatSessionSelection } from '@/components/chat/chatColumnSession';
import { useSessionUIStore, type NewSessionDraftState } from '@/sync/session-ui-store';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { getAttachedSessionDirectory } from '@/sync/session-worktree-contract';
import type { SessionWorktreeAttachment } from '@/stores/types/sessionTypes';
import { useSessionDirectory } from '@/sync/sync-context';
import { getAllSyncSessionMap } from '@/sync/sync-refs';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { getChatsRoot } from '@/lib/chatDirectories';
import { useChatsRoot } from '@/hooks/useChatsRoot';

type EffectiveDirectoryInputs = {
    currentSessionId: string | null;
    newSessionDraft: NewSessionDraftState;
    currentSessionDirectory: string | undefined;
    worktreeAttachment: SessionWorktreeAttachment | undefined;
    worktreePath: string | undefined;
    fallbackDirectory: string | null | undefined;
    chatsRoot: string | null;
};

/**
 * The one ordering behind both the hook and the imperative resolver, so the
 * two cannot drift apart.
 *
 * Priority order:
 * 1. Worktree attachment / metadata path (for worktree sessions)
 * 2. Session directory (for active sessions)
 * 3. Draft session directoryOverride (when creating a new session)
 * 4. For a Chat draft, the prepared chat directory or the managed Chats root —
 *    never the project the app was on before, which would leak that
 *    project's files, commands, and skills into the chat. None until the
 *    server names the root.
 * 5. Fallback directory from DirectoryStore
 */
const pickEffectiveDirectory = ({
    currentSessionId,
    newSessionDraft,
    currentSessionDirectory,
    worktreeAttachment,
    worktreePath,
    fallbackDirectory,
    chatsRoot,
}: EffectiveDirectoryInputs): string | undefined => {
    // If we have an active session, use its directory
    if (currentSessionId) {
        const attachmentDirectory = getAttachedSessionDirectory(worktreeAttachment);
        if (attachmentDirectory) {
            return attachmentDirectory;
        }
        if (worktreePath) {
            return worktreePath;
        }
        if (currentSessionDirectory) {
            return currentSessionDirectory;
        }
    }

    // If a draft session is open, use its directoryOverride
    if (newSessionDraft?.open && (newSessionDraft.bootstrapPendingDirectory || newSessionDraft.directoryOverride)) {
        return (newSessionDraft.bootstrapPendingDirectory || newSessionDraft.directoryOverride) ?? undefined;
    }

    if (newSessionDraft?.open && newSessionDraft.target === 'chat') {
        return newSessionDraft.preparedChatDirectory ?? chatsRoot ?? undefined;
    }

    // Fall back to the global directory
    return fallbackDirectory ?? undefined;
};

/**
 * Hook that resolves the effective working directory for tabs (Git, Diff, Files, Terminal).
 *
 * This ensures that tabs show content from the correct project directory
 * even when a draft session is being created.
 */
export const useEffectiveDirectory = (): string | undefined => {
    // Inside a chat column the session is the column's: a chat pinned in the
    // side panel resolves its own session's directory, not the main chat's.
    const currentSessionId = useChatSessionSelection().sessionId;
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const currentSessionDirectory = useSessionDirectory(currentSessionId);
    const worktreeAttachment = useSessionWorktreeStore((s) => currentSessionId ? s.getAttachment(currentSessionId) : undefined);
    const worktreeMap = useSessionUIStore((s) => s.worktreeMetadata);
    const fallbackDirectory = useDirectoryStore((s) => s.currentDirectory);
    const chatsRoot = useChatsRoot();

    return pickEffectiveDirectory({
        currentSessionId,
        newSessionDraft,
        currentSessionDirectory,
        worktreeAttachment,
        worktreePath: currentSessionId ? worktreeMap.get(currentSessionId)?.path : undefined,
        fallbackDirectory,
        chatsRoot,
    });
};

/**
 * Imperative twin of `useEffectiveDirectory` for the main chat: what the
 * hook returns outside a chat column, read once from the stores. For event
 * handlers in components that render many times (a session row) and must not
 * subscribe to the selection.
 */
export const resolveEffectiveDirectory = (): string | undefined => {
    const sessionUI = useSessionUIStore.getState();
    const currentSessionId = sessionUI.currentSessionId;
    const directoryState = useDirectoryStore.getState();

    return pickEffectiveDirectory({
        currentSessionId,
        newSessionDraft: sessionUI.newSessionDraft,
        // Same source as useSessionDirectory: the session record's own directory.
        currentSessionDirectory: currentSessionId
            ? getAllSyncSessionMap().get(currentSessionId)?.directory
            : undefined,
        worktreeAttachment: currentSessionId
            ? useSessionWorktreeStore.getState().getAttachment(currentSessionId)
            : undefined,
        worktreePath: currentSessionId ? sessionUI.worktreeMetadata.get(currentSessionId)?.path : undefined,
        fallbackDirectory: directoryState.currentDirectory,
        chatsRoot: getChatsRoot(),
    });
};
