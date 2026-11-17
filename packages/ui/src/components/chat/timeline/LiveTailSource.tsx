import React from 'react';

import { useSessionPartsForMessages } from '@/sync/sync-context';
import { buildLiveStreamingEntry } from '../lib/turns/streamingTailEntry';
import { EMPTY_ROW_MESSAGE_IDS } from './emptyCollections';
import type { RenderEntry } from './types';
import type { LiveTailStore } from './liveTailStore';

export const LiveTailSource: React.FC<{
    entry: RenderEntry | undefined;
    directory?: string;
    showTurnChangedFiles: boolean;
    store: LiveTailStore;
}> = ({ entry, directory, showTurnChangedFiles, store }) => {
    const tailMessageIds = React.useMemo(() => {
        if (!entry) return EMPTY_ROW_MESSAGE_IDS;
        if (entry.kind === 'turn') return entry.turn.assistantMessageIds;
        return [entry.message.info.id];
    }, [entry]);
    const livePartsByMessageId = useSessionPartsForMessages(tailMessageIds, directory);
    const liveEntry = React.useMemo(() => (entry ? buildLiveStreamingEntry(entry, {
        livePartsByMessageId,
        showTurnChangedFiles,
        mergeHiddenUserTurns: true,
    }) : null), [entry, livePartsByMessageId, showTurnChangedFiles]);
    store.set(liveEntry);
    React.useLayoutEffect(() => {
        store.notify();
    }, [liveEntry, store]);
    return null;
};
