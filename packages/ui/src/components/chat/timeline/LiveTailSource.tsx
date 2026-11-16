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
    // Overlay live parts on every message of the tail, not only the one
    // currently streaming: a finished step message's base record can lag the
    // part store, and rendering it from that stale snapshot briefly unmounts
    // its completed tool parts when the stream hands off to the next message.
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
    // Set while rendering, before the rows of this pass read it; the rows a
    // publish alone changes hear it after the commit.
    store.set(liveEntry);
    React.useLayoutEffect(() => {
        store.notify();
    }, [liveEntry, store]);
    return null;
};
