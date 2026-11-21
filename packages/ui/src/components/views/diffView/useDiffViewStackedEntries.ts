import React from 'react';
import type { DiffScope, FileEntry } from './types';

const STACKED_ENTRIES_FIRST = 16;
const STACKED_ENTRIES_PER_FRAME = 8;

interface DiffViewStackedEntriesOptions {
    isTreeMode: boolean;
    effectiveDirectory: string | undefined;
    activeDiffScope: DiffScope;
    changedFiles: FileEntry[];
    scrollRequestNonce: number;
}

export function useDiffViewStackedEntries({
    isTreeMode, effectiveDirectory, activeDiffScope, changedFiles, scrollRequestNonce,
}: DiffViewStackedEntriesOptions) {
    const stackedListKey = `${effectiveDirectory ?? ''}\0${activeDiffScope}`;
    const [stackedEntryLimit, setStackedEntryLimit] = React.useState({ key: stackedListKey, count: STACKED_ENTRIES_FIRST });
    const stackedEntryCount = stackedEntryLimit.key === stackedListKey ? stackedEntryLimit.count : STACKED_ENTRIES_FIRST;
    const stackedEntriesPending = !isTreeMode && stackedEntryCount < changedFiles.length;
    const seenScrollRequestRef = React.useRef(scrollRequestNonce);
    React.useLayoutEffect(() => {
        if (seenScrollRequestRef.current === scrollRequestNonce) return;
        seenScrollRequestRef.current = scrollRequestNonce;
        setStackedEntryLimit({ key: stackedListKey, count: Number.POSITIVE_INFINITY });
    }, [scrollRequestNonce, stackedListKey]);
    React.useEffect(() => {
        if (!stackedEntriesPending) {
            if (!isTreeMode && Number.isFinite(stackedEntryCount)) setStackedEntryLimit({ key: stackedListKey, count: Number.POSITIVE_INFINITY });
            return undefined;
        }
        const frame = window.requestAnimationFrame(() => {
            setStackedEntryLimit({ key: stackedListKey, count: stackedEntryCount + STACKED_ENTRIES_PER_FRAME });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [isTreeMode, stackedEntriesPending, stackedEntryCount, stackedListKey]);

    return { stackedEntryCount, stackedEntriesPending };
}
