import React from 'react';
import type { Message, Part } from '@/lib/opencode/model';
import { useConfigStore } from '@/stores/useConfigStore';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { useAutoReadAloud } from '@/hooks/useAutoReadAloud';
import { findLatestCompletedReply } from '@/lib/messages/latestReply';

export const useColumnAutoReadAloud = ({
    pinned,
    currentSessionKey,
    ready,
    sessionIsWorking,
    sessionStatusType,
    sessionMessages,
    olderCompletedReplyIds,
}: {
    pinned: boolean;
    currentSessionKey: string | null;
    ready: boolean;
    sessionIsWorking: boolean;
    sessionStatusType: string | undefined;
    sessionMessages: Array<{ info: Message; parts: Part[] }>;
    olderCompletedReplyIds: Parameters<typeof useAutoReadAloud>[0]['olderCompletedReplyIds'];
}): void => {
    const latestCompletedReply = React.useMemo(
        () => findLatestCompletedReply(sessionMessages),
        [sessionMessages],
    );
    const autoReadAloudEnabled = useConfigStore((state) => state.autoReadAloudEnabled);
    const { play: playAutoReadAloud } = useMessageTTS(latestCompletedReply?.messageId);
    const sessionIsActive = sessionIsWorking
        || sessionStatusType === 'busy'
        || sessionStatusType === 'retry';
    useAutoReadAloud({
        sessionKey: currentSessionKey ?? '',
        ready,
        sessionIsActive,
        reply: latestCompletedReply,
        history: sessionMessages,
        olderCompletedReplyIds,
        enabled: autoReadAloudEnabled && !pinned,
        play: playAutoReadAloud,
    });
};
