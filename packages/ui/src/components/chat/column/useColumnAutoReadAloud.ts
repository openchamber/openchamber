import React from 'react';
import type { Message, Part } from '@/lib/opencode/model';
import { useConfigStore } from '@/stores/useConfigStore';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { useAutoReadAloud } from '@/hooks/useAutoReadAloud';
import { findLatestCompletedReply } from '@/lib/messages/latestReply';

/** Reads the newest completed reply aloud when the setting is on; never in a pinned column. */
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
    // Use the reply's own message id as the reading key so the message
    // button shows the auto-started reading as playing and can stop it.
    const { play: playAutoReadAloud } = useMessageTTS(latestCompletedReply?.messageId);
    // Permission prompts pause `sessionIsWorking` while the turn is still
    // running, so status also marks the session as active for the auto-read
    // baseline.
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
