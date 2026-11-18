import React from 'react';
import type { DiffScope, FileEntry } from './types';

// The stacked list mounts this many file entries at once and the rest a
// frame's worth at a time: every entry of a long change mounted in one commit
// froze the first open of the view for a frame per ten or so files.
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
    // How many entries of the stacked list are mounted. A request to scroll to
    // a file mounts them all at once: its entry may be past the limit, and the
    // alignment waits only a few frames for it. The scope or directory
    // changing starts a new list, so the limit starts over with it.
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
            // Fully mounted: files that appear later mount with the list.
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
