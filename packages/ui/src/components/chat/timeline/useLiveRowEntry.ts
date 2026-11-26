import React from 'react';

import { useSessionPartsForMessages } from '@/sync/sync-context';
import { buildSameRows } from '../lib/turns/liveRowParts';
import { buildLiveStreamingEntry } from '../lib/turns/streamingTailEntry';
import { EMPTY_ROW_MESSAGE_IDS } from './emptyCollections';
import type { RenderEntry } from './types';

export const useLiveRowEntry = (
    entry: RenderEntry | undefined,
    { enabled, directory, showTurnChangedFiles }: { enabled: boolean; directory?: string; showTurnChangedFiles: boolean },
): RenderEntry | undefined => {
    const messageIds = enabled && entry?.kind === 'turn' ? entry.turn.assistantMessageIds : EMPTY_ROW_MESSAGE_IDS;
    const livePartsByMessageId = useSessionPartsForMessages(messageIds, directory, buildSameRows);
    return React.useMemo(() => (
        entry && messageIds.length > 0
            ? buildLiveStreamingEntry(entry, { livePartsByMessageId, showTurnChangedFiles, mergeHiddenUserTurns: true })
            : entry
    ), [entry, livePartsByMessageId, messageIds, showTurnChangedFiles]);
};
