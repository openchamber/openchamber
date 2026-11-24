import { toast } from '@/components/ui';
import { getChatDraftIdentityKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import type { useI18n } from '@/lib/i18n';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { useInputStore } from '@/sync/input-store';

export const saveAttachmentsHeldForSend = async (
    target: ChatDraftIdentity | null,
    directory: string | undefined,
    sent: readonly AttachedFile[],
    t: ReturnType<typeof useI18n>['t'],
): Promise<'none' | 'saved' | 'stopped'> => {
    if (!sent.some((file) => file.saveOnSend || file.saveCopyOnSend)) return 'none';
    const isCurrentRuntime = captureRuntimeInstance();
    const failed = await useInputStore.getState().saveAttachmentsHeldForSend(target, directory, new Set(sent.map((file) => file.id)));
    if (failed.length > 0) {
        toast.error(t('chat.chatInput.toast.imageCopySaveFailed', { files: failed.join(', ') }));
        return 'stopped';
    }
    const draftKey = target ? getChatDraftIdentityKey(target) : null;
    return isCurrentRuntime() && useInputStore.getState().attachmentDraftKey === draftKey ? 'saved' : 'stopped';
};
