import React from 'react';
import { buildDiffTreeRows } from '../diffFileTree';
import { useKeybinds } from '@/hooks/useKeybind';
import type { FileEntry } from './types';

interface DiffViewFileSelectionOptions {
    isTreeMode: boolean;
    changedFiles: FileEntry[];
    displayFile: string | null;
    expandedFiles: Set<string>;
    expandStackedFile: (path: string) => void;
    cancelPendingScrollAlignment: () => void;
    setDisplayFile: React.Dispatch<React.SetStateAction<string | null>>;
    setDisplayFileStaged: React.Dispatch<React.SetStateAction<boolean>>;
    diffScrollRef: React.RefObject<HTMLElement | null>;
    shouldPinAfterAlignRef: React.RefObject<boolean>;
    pendingScrollTargetRef: React.RefObject<string | null>;
    setScrollRequestNonce: React.Dispatch<React.SetStateAction<number>>;
    scrollToFile: (path: string) => boolean;
    visible: boolean;
    forcedStaged: boolean | null;
    displayFileStaged: boolean;
}

export function useDiffViewFileSelection({
    isTreeMode, changedFiles, displayFile, expandedFiles, expandStackedFile, cancelPendingScrollAlignment,
    setDisplayFile, setDisplayFileStaged, diffScrollRef, shouldPinAfterAlignRef, pendingScrollTargetRef,
    setScrollRequestNonce, scrollToFile, visible, forcedStaged, displayFileStaged,
}: DiffViewFileSelectionOptions) {
    // Which side of a file's diff is showing: the scope can force it, otherwise
    // only the file the user opened on the staged side is staged.
    const getFileStaged = React.useCallback((path: string) => {
        if (forcedStaged !== null) {
            return forcedStaged;
        }
        return displayFileStaged && path === displayFile;
    }, [displayFile, displayFileStaged, forcedStaged]);
    const handleSelectFile = React.useCallback((value: string) => {
        void value;
    }, []);
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
    }, [cancelPendingScrollAlignment, expandStackedFile, isTreeMode, scrollToFile]);

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

    return { treeSelectedFile, handleSelectFileAndScroll, getFileStaged, handleSelectFile };
}
