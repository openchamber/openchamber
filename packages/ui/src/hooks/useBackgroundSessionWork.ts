import React from 'react';
import { useChatColumnSession } from '@/components/chat/chatColumnSession';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Moves what the shown session's turn is blocked on (a running shell command,
 * a subagent it waits for) to the background, for the session the status row
 * describes. The caller decides when that is possible (`working.canBackground`
 * from `useAssistantStatus`); OpenCode ignores the request when nothing blocks.
 */
export function useBackgroundSessionWork(): () => void {
    const { t } = useI18n();
    const chatColumnSession = useChatColumnSession();
    const liveSessionId = useSessionUIStore((state) => state.currentSessionId);
    const liveSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
    const sessionId = chatColumnSession ? chatColumnSession.sessionId : liveSessionId;
    const directory = chatColumnSession ? chatColumnSession.directory : liveSessionDirectory;

    return React.useCallback(() => {
        if (!sessionId) return;
        opencodeClient.backgroundSessionWork(sessionId, directory).catch(() => {
            toast.error(t('chat.statusRow.background.failed'));
        });
    }, [directory, sessionId, t]);
}
