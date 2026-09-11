import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { getAttachedSessionDirectory } from '@/sync/session-worktree-contract';
import { useSessionDirectory } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { getChatsRootForHome } from '@/lib/chatDirectories';

/**
 * Hook that resolves the effective working directory for tabs (Git, Diff, Files, Terminal).
 *
 * Priority order:
 * 1. Worktree metadata path (for worktree sessions)
 * 2. Session directory (for active sessions)
 * 3. Draft session directoryOverride (when creating a new session)
 * 4. For a Chat draft, the prepared chat directory or the managed Chats root —
 *    never the project the app was on before, which would leak that
 *    project's files, commands, and skills into the chat
 * 5. Fallback directory from DirectoryStore
 *
 * This ensures that tabs show content from the correct project directory
 * even when a draft session is being created.
 */
export const useEffectiveDirectory = (): string | undefined => {
    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const currentSessionDirectory = useSessionDirectory(currentSessionId);
    const worktreeAttachment = useSessionWorktreeStore((s) => currentSessionId ? s.getAttachment(currentSessionId) : undefined);
    const worktreeMap = useSessionUIStore((s) => s.worktreeMetadata);
    const fallbackDirectory = useDirectoryStore((s) => s.currentDirectory);
    const homeDirectory = useDirectoryStore((s) => s.homeDirectory);

    // If we have an active session, use its directory
    if (currentSessionId) {
        const attachmentDirectory = getAttachedSessionDirectory(worktreeAttachment);
        if (attachmentDirectory) {
            return attachmentDirectory;
        }
        const worktreeMetadata = worktreeMap.get(currentSessionId);
        if (worktreeMetadata?.path) {
            return worktreeMetadata.path;
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
        const chatDirectory = newSessionDraft.preparedChatDirectory ?? getChatsRootForHome(homeDirectory);
        if (chatDirectory) return chatDirectory;
    }

    // Fall back to the global directory
    return fallbackDirectory ?? undefined;
};
