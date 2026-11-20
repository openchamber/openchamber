import React from 'react';

import { useRunningSubagentRuns, withRunningSubagentRuns } from '../lib/runningSubagentRuns';
import { getNormalizedMessageForDisplay } from '../lib/messageDisplayNormalization';
import { attachSyntheticContext } from '../lib/attachSyntheticContext';
import { applyRetryOverlay } from '../lib/turns/applyRetryOverlay';
import { streamPerfMeasure } from '@/stores/utils/streamDebug';
import type { ChatMessageEntry } from '../lib/turns/types';
import type { RetryOverlay } from './types';

export const useDisplayMessages = (
    messages: ChatMessageEntry[],
    sessionKey: string,
    directory: string | undefined,
    retryOverlay: RetryOverlay | null,
) => {
    const runningSubagentRuns = useRunningSubagentRuns(sessionKey, directory);

    const baseDisplayMessages = React.useMemo(() => streamPerfMeasure('ui.message_list.base_display_ms', () => {
        const timeline = withRunningSubagentRuns(messages, runningSubagentRuns);
        const seenIds = new Set<string>();
        const latestById = new Map<string, ChatMessageEntry>();
        const dedupedMessages: ChatMessageEntry[] = [];
        for (const message of timeline) {
            const messageId = message.info?.id;
            if (typeof messageId === 'string') latestById.set(messageId, message);
        }

        for (let index = 0; index < timeline.length; index += 1) {
            const message = timeline[index];
            const messageId = message.info?.id;
            if (typeof messageId === 'string') {
                if (seenIds.has(messageId)) {
                    continue;
                }
                seenIds.add(messageId);
            }
            dedupedMessages.push(getNormalizedMessageForDisplay(
                typeof messageId === 'string' ? latestById.get(messageId) ?? message : message,
            ));
        }

        return attachSyntheticContext(dedupedMessages);
    }), [messages, runningSubagentRuns]);

    const displayMessages = React.useMemo(() => streamPerfMeasure('ui.message_list.retry_overlay_ms', () => {
        return applyRetryOverlay(
            baseDisplayMessages,
            retryOverlay?.sessionId === sessionKey ? retryOverlay : null,
        );
    }), [baseDisplayMessages, retryOverlay, sessionKey]);

    return { baseDisplayMessages, displayMessages };
};
