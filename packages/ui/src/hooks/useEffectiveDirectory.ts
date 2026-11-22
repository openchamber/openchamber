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

const pickEffectiveDirectory = ({
    currentSessionId,
    newSessionDraft,
    currentSessionDirectory,
    worktreeAttachment,
    worktreePath,
    fallbackDirectory,
    chatsRoot,
}: EffectiveDirectoryInputs): string | undefined => {
    if (currentSessionId) {
        if (currentSessionDirectory) {
            return currentSessionDirectory;
        }
        const attachmentDirectory = getAttachedSessionDirectory(worktreeAttachment);
        if (attachmentDirectory) {
            return attachmentDirectory;
        }
        if (worktreePath) {
            return worktreePath;
        }
    }

    if (newSessionDraft?.open && (newSessionDraft.bootstrapPendingDirectory || newSessionDraft.directoryOverride)) {
        return (newSessionDraft.bootstrapPendingDirectory || newSessionDraft.directoryOverride) ?? undefined;
    }

    if (newSessionDraft?.open && newSessionDraft.target === 'chat') {
        return newSessionDraft.preparedChatDirectory ?? chatsRoot ?? undefined;
    }

    return fallbackDirectory ?? undefined;
};

export const useEffectiveDirectory = (): string | undefined => {
    const { sessionId: currentSessionId, directory: selectedDirectory } = useChatSessionSelection();
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const currentSessionDirectory = useSessionDirectory(currentSessionId);
    const worktreeAttachment = useSessionWorktreeStore((s) => currentSessionId ? s.getAttachment(currentSessionId) : undefined);
    const worktreePath = useSessionUIStore((s) => currentSessionId ? s.worktreeMetadata.get(currentSessionId)?.path : undefined);
    const fallbackDirectory = useDirectoryStore((s) => s.currentDirectory);
    const chatsRoot = useChatsRoot();

    return pickEffectiveDirectory({
        currentSessionId,
        newSessionDraft,
        currentSessionDirectory,
        worktreeAttachment,
        worktreePath,
        fallbackDirectory: currentSessionId ? selectedDirectory ?? fallbackDirectory : fallbackDirectory,
        chatsRoot,
    });
};

export const resolveEffectiveDirectory = (): string | undefined => {
    const sessionUI = useSessionUIStore.getState();
    const currentSessionId = sessionUI.currentSessionId;
    const directoryState = useDirectoryStore.getState();

    return pickEffectiveDirectory({
        currentSessionId,
        newSessionDraft: sessionUI.newSessionDraft,
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
