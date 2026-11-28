import React from 'react';
import { buildDiffTreeRows } from '../diffFileTree';
import { useChangedFileStepping } from './useChangedFileStepping';
import type { DiffData, FileEntry } from './types';

interface DiffViewFileSelectionOptions {
    isTreeMode: boolean;
    unreviewedOnly: boolean;
    changedFiles: FileEntry[];
    displayFile: string | null;
    expandedFiles: Set<string>;
    expandStackedFile: (path: string) => void;
    cancelPendingScrollAlignment: () => void;
    setDisplayFile: React.Dispatch<React.SetStateAction<string | null>>;
    setDisplayFileStaged: React.Dispatch<React.SetStateAction<boolean>>;
    diffScrollRef: React.RefObject<HTMLElement | null>;
    rootRef: React.RefObject<HTMLElement | null>;
    shouldPinAfterAlignRef: React.RefObject<boolean>;
    pendingScrollTargetRef: React.RefObject<string | null>;
    setScrollRequestNonce: React.Dispatch<React.SetStateAction<number>>;
    scrollToFile: (path: string) => boolean;
    visible: boolean;
    forcedStaged: boolean | null;
    displayFileStaged: boolean;
    reviewedPaths: ReadonlySet<string>;
    toggleReviewed: (path: string, diff: DiffData | null) => void;
}

export function useDiffViewFileSelection({
    isTreeMode, unreviewedOnly, changedFiles, displayFile, expandedFiles, expandStackedFile, cancelPendingScrollAlignment,
    setDisplayFile, setDisplayFileStaged, diffScrollRef, rootRef, shouldPinAfterAlignRef, pendingScrollTargetRef,
    setScrollRequestNonce, scrollToFile, visible, forcedStaged, displayFileStaged, reviewedPaths, toggleReviewed,
}: DiffViewFileSelectionOptions) {
    const getFileStaged = React.useCallback((path: string) => {
        if (forcedStaged !== null) {
            return forcedStaged;
        }
        return displayFileStaged && path === displayFile;
    }, [displayFile, displayFileStaged, forcedStaged]);
    const treeFileOrder = React.useMemo(
        () => (isTreeMode
            ? buildDiffTreeRows(changedFiles, new Set()).flatMap((row) => (row.kind === 'file' ? [row.file] : []))
            : []),
        [changedFiles, isTreeMode],
    );
    const navigationFiles = isTreeMode ? treeFileOrder : changedFiles;
    const treeSelectedFile = isTreeMode
        ? (treeFileOrder.find((file) => file.path === displayFile)
            ?? (unreviewedOnly && displayFile && reviewedPaths.has(displayFile) ? null : treeFileOrder[0] ?? null))
        : null;
    const treeSelectedPath = treeSelectedFile?.path ?? null;
    React.useEffect(() => {
        if (treeSelectedPath && !expandedFiles.has(treeSelectedPath)) {
            expandStackedFile(treeSelectedPath);
        }
    }, [expandStackedFile, expandedFiles, treeSelectedPath]);

    const handleSelectFileAndScroll = React.useCallback((value: string) => {
        cancelPendingScrollAlignment();
        if (isTreeMode) {
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

    const currentPath = isTreeMode ? treeSelectedFile?.path : displayFile;
    const handleSelectFile = React.useCallback((path: string) => {
        if (path === displayFile) return;
        setDisplayFileStaged(false);
        setDisplayFile(path);
    }, [displayFile, setDisplayFile, setDisplayFileStaged]);
    const toggleAndAdvance = useChangedFileStepping({
        visible,
        rootRef,
        files: navigationFiles,
        currentIndex: currentPath ? navigationFiles.findIndex((file) => file.path === currentPath) : -1,
        onStep: (file) => handleSelectFileAndScroll(file.path),
        review: {
            path: (file) => file.path,
            isReviewed: (file) => reviewedPaths.has(file.path),
            toggle: (file, diff) => toggleReviewed(file.path, diff),
        },
    });

    return { treeSelectedFile, handleSelectFileAndScroll, getFileStaged, handleSelectFile,
        toggleReviewedAndAdvance: (path: string, diff: DiffData | null) => {
            const file = navigationFiles.find((entry) => entry.path === path);
            if (file) toggleAndAdvance(file, diff);
        },
    };
}
