import { toast } from '@/components/ui';
import { getChatDraftIdentityKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import type { useI18n } from '@/lib/i18n';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { useInputStore } from '@/sync/input-store';

export const saveAttachmentsHeldForSend = async (
    target: ChatDraftIdentity | null,
    directory: string | undefined,
    t: ReturnType<typeof useI18n>['t'],
): Promise<'none' | 'saved' | 'stopped'> => {
    const input = useInputStore.getState();
    if (!input.getAttachedFiles(target).some((file) => file.saveOnSend)) return 'none';
    const isCurrentRuntime = captureRuntimeInstance();
    const failed = await input.saveAttachmentsHeldForSend(target, directory);
    if (failed.length > 0) {
        toast.error(t('chat.chatInput.toast.imageCopySaveFailed', { files: failed.join(', ') }));
        return 'stopped';
    }
    const draftKey = target ? getChatDraftIdentityKey(target) : null;
    return isCurrentRuntime() && useInputStore.getState().attachmentDraftKey === draftKey ? 'saved' : 'stopped';
};
