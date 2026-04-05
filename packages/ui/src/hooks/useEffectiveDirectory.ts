import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionDirectory } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

/**
 * Hook that resolves the effective working directory for tabs (Git, Diff, Files, Terminal).
 *
 * Priority order:
 * 1. Worktree metadata path (for worktree sessions)
 * 2. Session directory (for active sessions)
 * 3. Draft session directoryOverride (when creating a new session)
 * 4. Fallback directory from DirectoryStore
 *
 * This ensures that tabs show content from the correct project directory
 * even when a draft session is being created.
 */
export const useEffectiveDirectory = (): string | undefined => {
    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const currentSessionDirectory = useSessionDirectory(currentSessionId);
    const worktreeMap = useSessionUIStore((s) => s.worktreeMetadata);
    const fallbackDirectory = useDirectoryStore((s) => s.currentDirectory);

    // If we have an active session, use its directory
    if (currentSessionId) {
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

    // Fall back to the global directory
    return fallbackDirectory ?? undefined;
};
