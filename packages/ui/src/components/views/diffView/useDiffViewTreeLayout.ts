import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { isRightToLeft } from '@/lib/i18n';
import { buildDiffTreeRows } from '../diffFileTree';
import { useKeybinds } from '@/hooks/useKeybind';
import { useDiffViewSetup } from './useDiffViewSetup';
import { useDiffViewComparisons } from './useDiffViewComparisons';
import { useDiffViewScrollAlignment } from './useDiffViewScrollAlignment';

// The stacked list mounts this many file entries at once and the rest a
// frame's worth at a time: every entry of a long change mounted in one commit
// froze the first open of the view for a frame per ten or so files.
const STACKED_ENTRIES_FIRST = 16;
const STACKED_ENTRIES_PER_FRAME = 8;
const FILE_TREE_MIN_WIDTH = 160;
const FILE_TREE_MAX_FRACTION = 0.5;

type useDiffViewTreeLayoutProps = Pick<ReturnType<typeof useDiffViewSetup>,
    'diffFileListMode' | 'isMobileLayout' | 'effectiveDirectory' | 'activeDiffScope' | 'scrollRequestNonce' |
    'displayFile' | 'expandedFiles' | 'expandStackedFile' | 'cancelPendingScrollAlignment' | 'setDisplayFile' |
    'setDisplayFileStaged' | 'diffScrollRef' | 'shouldPinAfterAlignRef' | 'pendingScrollTargetRef' |
    'setScrollRequestNonce'
> & Pick<ReturnType<typeof useDiffViewComparisons>,
    'changedFiles'
> & Pick<ReturnType<typeof useDiffViewScrollAlignment>,
    'scrollToFile'
> & {
    visible: boolean;
};

export function useDiffViewTreeLayout({
    diffFileListMode, isMobileLayout, effectiveDirectory, activeDiffScope, changedFiles, scrollRequestNonce, displayFile,
    expandedFiles, expandStackedFile, cancelPendingScrollAlignment, setDisplayFile, setDisplayFileStaged, diffScrollRef,
    shouldPinAfterAlignRef, pendingScrollTargetRef, setScrollRequestNonce, scrollToFile, visible,
}: useDiffViewTreeLayoutProps) {
    const isTreeMode = diffFileListMode === 'tree' && !isMobileLayout;
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
    const storedFileTreeWidth = useUIStore((state) => state.diffFileTreeWidth);
    const setStoredFileTreeWidth = useUIStore((state) => state.setDiffFileTreeWidth);
    const fileTreeLayoutRef = React.useRef<HTMLDivElement | null>(null);
    const [draggingFileTree, setDraggingFileTree] = React.useState(false);
    const fileTreeWidth = Math.max(storedFileTreeWidth, FILE_TREE_MIN_WIDTH);

    const clampFileTreeWidth = React.useCallback((width: number) => {
        const maxWidth = Math.max(FILE_TREE_MIN_WIDTH, (fileTreeLayoutRef.current?.clientWidth ?? 0) * FILE_TREE_MAX_FRACTION);
        return Math.min(maxWidth, Math.max(FILE_TREE_MIN_WIDTH, width));
    }, []);

    const handleFileTreeResizeStart = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = fileTreeWidth;
        // The tree sits at the start; in RTL that is the right, so dragging left widens it.
        const sign = isRightToLeft(event.currentTarget) ? -1 : 1;
        setDraggingFileTree(true);

        const onMove = (moveEvent: PointerEvent) => {
            setStoredFileTreeWidth(clampFileTreeWidth(startWidth + (moveEvent.clientX - startX) * sign));
        };
        const onUp = () => {
            setDraggingFileTree(false);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    }, [clampFileTreeWidth, fileTreeWidth, setStoredFileTreeWidth]);

    const handleFileTreeResizeKey = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? 40 : 10;
        const sign = isRightToLeft(event.currentTarget) ? -1 : 1;
        const delta = (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0) * sign;
        if (delta === 0) return;
        event.preventDefault();
        setStoredFileTreeWidth(clampFileTreeWidth(fileTreeWidth + delta));
    }, [clampFileTreeWidth, fileTreeWidth, setStoredFileTreeWidth]);

    // Tree mode walks files in the order the tree shows them.
    const treeFileOrder = React.useMemo(
        () => (isTreeMode
            ? buildDiffTreeRows(changedFiles, new Set()).flatMap((row) => (row.kind === 'file' ? [row.file] : []))
            : []),
        [changedFiles, isTreeMode],
    );
    const navigationFiles = isTreeMode ? treeFileOrder : changedFiles;
    const treeSelectedFile = isTreeMode
        ? (treeFileOrder.find((file) => file.path === displayFile) ?? treeFileOrder[0] ?? null)
        : null;
    const treeSelectedPath = treeSelectedFile?.path ?? null;

    // Tree mode renders its file open whether or not it is in the expanded
    // set, but branch/commit/PR diffs are fetched only for expanded paths:
    // the default first file would otherwise wait on a diff nobody requests.
    React.useEffect(() => {
        if (treeSelectedPath && !expandedFiles.has(treeSelectedPath)) {
            expandStackedFile(treeSelectedPath);
        }
    }, [expandStackedFile, expandedFiles, treeSelectedPath]);

    const handleSelectFileAndScroll = React.useCallback((value: string) => {
        cancelPendingScrollAlignment();

        if (isTreeMode) {
            // Tree mode shows one file at a time, opened from the top.
            setDisplayFile(value);
            setDisplayFileStaged(false);
            expandStackedFile(value);
            diffScrollRef.current?.scrollTo({ top: 0 });
            return;
        }

        setDisplayFile(value);
        setDisplayFileStaged(false);
        shouldPinAfterAlignRef.current = true;
        pendingScrollTargetRef.current = value;
        expandStackedFile(value);
        setScrollRequestNonce((nonce) => nonce + 1);
        scrollToFile(value);
    }, [cancelPendingScrollAlignment, expandStackedFile, isTreeMode, scrollToFile, shouldPinAfterAlignRef, diffScrollRef, setScrollRequestNonce, pendingScrollTargetRef, setDisplayFileStaged, setDisplayFile]);

    // Step review to the adjacent changed file: selects, expands a collapsed
    // section, and scrolls to it. Guarded off editable fields, because the
    // diff surface has no persistent focus target.
    const stepChangedFile = (event: KeyboardEvent, delta: -1 | 1): boolean | void => {
        if (!visible) return false;
        const target = event.target;
        if (target instanceof HTMLElement && (
            target.isContentEditable
            || target.tagName === 'INPUT'
            || target.tagName === 'TEXTAREA'
            || target.closest('[role="dialog"]')
        )) {
            return false;
        }
        if (navigationFiles.length === 0) return;
        const currentPath = isTreeMode ? treeSelectedFile?.path : displayFile;
        const index = currentPath ? navigationFiles.findIndex((file) => file.path === currentPath) : -1;
        const nextIndex = index === -1
            ? (delta > 0 ? 0 : navigationFiles.length - 1)
            : index + delta;
        const next = navigationFiles[nextIndex];
        if (!next) return;
        handleSelectFileAndScroll(next.path);
    };
    useKeybinds({
        diff_next_file: (event) => stepChangedFile(event, 1),
        diff_previous_file: (event) => stepChangedFile(event, -1),
    });


    return {
        isTreeMode, stackedEntryCount, stackedEntriesPending, fileTreeLayoutRef, draggingFileTree, fileTreeWidth,
        handleFileTreeResizeStart, handleFileTreeResizeKey, treeSelectedFile, handleSelectFileAndScroll,
    };
}
