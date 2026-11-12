import React from 'react';
import { useChatSessionSelection } from '@/components/chat/chatColumnSession';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';

/**
 * Moves what the shown session's turn is blocked on (a running shell command,
 * a subagent it waits for) to the background, for the session the status row
 * describes. The caller decides when that is possible (`working.canBackground`
 * from `useAssistantStatus`); OpenCode ignores the request when nothing blocks.
 */
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
