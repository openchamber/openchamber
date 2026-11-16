import React from 'react';
import { useChatSessionSelection } from '@/components/chat/chatColumnSession';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';

export function useBackgroundSessionWork(): () => void {
    const { t } = useI18n();
    const { sessionId, directory } = useChatSessionSelection();

    return React.useCallback(() => {
        if (!sessionId) return;
        opencodeClient.backgroundSessionWork(sessionId, directory).catch(() => {
            toast.error(t('chat.statusRow.background.failed'));
        });
    }, [directory, sessionId, t]);
}
