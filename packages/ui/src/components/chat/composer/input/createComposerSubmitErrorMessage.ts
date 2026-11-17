import type { useI18n } from '@/lib/i18n';

export const createComposerSubmitErrorMessage = (t: ReturnType<typeof useI18n>['t']) =>
    (error: unknown, fallback: string) => {
        const message = error instanceof Error ? error.message : '';
        return message.toLowerCase().includes('runtime changed')
            ? t('chat.chatInput.toast.messageSendFailed')
            : message || fallback;
    };
