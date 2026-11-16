import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';
import type { ReviewTransferDirection } from '@/lib/reviewFlow';
import type { StreamPhase } from '../message/types';
import type { LiveTailStore } from './liveTailStore';
import type { ToggleTurnActivity } from './types';

export type TimelineRowContextValue = {
    scrollToBottom?: () => void;
    turnExpansion: Map<string, boolean>;
    onToggleTurnActivity: ToggleTurnActivity;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    reviewTransferDirection?: ReviewTransferDirection | null;
    // The rows of the live tail read its live entry; every other row renders
    // its entry as it is.
    streamingTailKey: string | null;
    liveTail: LiveTailStore;
    sessionIsWorking: boolean;
    activeStreamingMessageId: string | null;
    activeStreamingPhase: StreamPhase | null;
};

export const TimelineRowContext = React.createContext<TimelineRowContextValue | null>(null);
