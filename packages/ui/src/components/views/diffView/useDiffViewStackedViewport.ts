import React from 'react';
import { findDiffScrollAnchor, type DiffScrollAnchor } from '../diffScrollAnchor';
import type { FileEntry, DiffScope } from './types';

const SIDE_BY_SIDE_MIN_WIDTH = 1100;
const STACKED_DIFF_MOUNT_MARGIN = 300;
const getStackedViewDefaultExpandedCount = (fileCount: number): number => {
    if (fileCount <= 6) return fileCount;
    if (fileCount <= 12) return 6;
    if (fileCount <= 25) return 4;
    return 2;
};

interface DiffViewStackedViewportOptions {
    effectiveDirectory: string | undefined;
    activeDiffScope: DiffScope;
    setExpandedFiles: React.Dispatch<React.SetStateAction<Set<string>>>;
    setMountedStackedFiles: React.Dispatch<React.SetStateAction<Set<string>>>;
    diffScrollRef: React.RefObject<HTMLElement | null>;
    fileSectionRefs: React.RefObject<Map<string, HTMLDivElement | null>>;
    expandedFiles: Set<string>;
    lastScrollAnchorRef: React.RefObject<DiffScrollAnchor | null>;
    diffFileLayout: Record<string, 'inline' | 'side-by-side'>;
    diffLayoutPreference: 'dynamic' | 'inline' | 'side-by-side';
    screenWidth: number;
    changedFilePathsKey: string;
    changedFiles: FileEntry[];
    stackedDefaultCollapsedAll: boolean;
    visible: boolean;
    cancelPendingScrollAlignment: () => void;
    reviewedPaths?: ReadonlySet<string>;
}

export function useDiffViewStackedViewport({
    changedFilePathsKey, effectiveDirectory, activeDiffScope, stackedDefaultCollapsedAll,
    setExpandedFiles, setMountedStackedFiles, visible, diffScrollRef, fileSectionRefs,
    expandedFiles, lastScrollAnchorRef, changedFiles, diffFileLayout, diffLayoutPreference, screenWidth,
    cancelPendingScrollAlignment, reviewedPaths,
}: DiffViewStackedViewportOptions) {
    const visibleSyncFrameRef = React.useRef<number | null>(null);
    const stackedStateScopeRef = React.useRef<string | null>(null);
    const reviewedPathsRef = React.useRef(reviewedPaths);
    reviewedPathsRef.current = reviewedPaths;
    React.useEffect(() => {
        const paths = changedFilePathsKey ? changedFilePathsKey.split('\0') : [];
        const pathSet = new Set(paths);
        const scopeKey = `${effectiveDirectory ?? ''}:${activeDiffScope}:${stackedDefaultCollapsedAll ? 'collapsed' : 'default'}`;
        const shouldInitialize = stackedStateScopeRef.current !== scopeKey;
        stackedStateScopeRef.current = scopeKey;

        setExpandedFiles((previous) => {
            if (shouldInitialize) {
                const defaultExpandedCount = stackedDefaultCollapsedAll
                    ? 0
                    : getStackedViewDefaultExpandedCount(paths.length);
                const reviewed = reviewedPathsRef.current;
                const unreviewed = reviewed?.size
                    ? paths.filter((path) => !reviewed.has(path))
                    : paths;
                return new Set(unreviewed.slice(0, defaultExpandedCount));
            }

            let changed = false;
            const next = new Set<string>();
            for (const path of previous) {
                if (!pathSet.has(path)) {
                    changed = true;
                    continue;
                }
                next.add(path);
            }
            return changed ? next : previous;
        });

        setMountedStackedFiles((previous) => {
            if (shouldInitialize) {
                return new Set();
            }

            let changed = false;
            const next = new Set<string>();
            for (const path of previous) {
                if (!pathSet.has(path)) {
                    changed = true;
                    continue;
                }
                next.add(path);
            }
            return changed ? next : previous;
        });
    }, [activeDiffScope, changedFilePathsKey, effectiveDirectory, stackedDefaultCollapsedAll]);

    const syncVisibleStackedFiles = React.useCallback(() => {
        visibleSyncFrameRef.current = null;
        if (!visible) return;
        const scrollRoot = diffScrollRef.current;
        if (!scrollRoot) return;

        const rootRect = scrollRoot.getBoundingClientRect();
        const top = rootRect.top - STACKED_DIFF_MOUNT_MARGIN;
        const bottom = rootRect.bottom + STACKED_DIFF_MOUNT_MARGIN;
        const next: Record<string, boolean> = {};
        const sectionPositions: Array<{ path: string; top: number }> = [];

        for (const [path, node] of fileSectionRefs.current) {
            if (!node) continue;
            const rect = node.getBoundingClientRect();
            sectionPositions.push({ path, top: rect.top });
            if (!expandedFiles.has(path)) continue;
            if (rect.bottom < top || rect.top > bottom) continue;
            next[path] = true;
        }
        lastScrollAnchorRef.current = findDiffScrollAnchor(rootRect.top, sectionPositions);

        setMountedStackedFiles((previous) => {
            let changed = false;
            const mounted = new Set(previous);
            for (const path of Object.keys(next)) {
                if (mounted.has(path)) continue;
                mounted.add(path);
                changed = true;
            }
            return changed ? mounted : previous;
        });
    }, [expandedFiles, visible]);

    const queueVisibleStackedFilesSync = React.useCallback(() => {
        if (!visible) return;
        if (typeof window === 'undefined') return;
        if (visibleSyncFrameRef.current !== null) return;
        visibleSyncFrameRef.current = window.requestAnimationFrame(syncVisibleStackedFiles);
    }, [syncVisibleStackedFiles, visible]);
    const queueVisibleStackedFilesSyncRef = React.useRef(queueVisibleStackedFilesSync);
    queueVisibleStackedFilesSyncRef.current = queueVisibleStackedFilesSync;

    React.useEffect(() => {
        const scrollRoot = diffScrollRef.current;
        if (!visible || !scrollRoot) return;

        queueVisibleStackedFilesSync();
        scrollRoot.addEventListener('scroll', queueVisibleStackedFilesSync, { passive: true });
        window.addEventListener('resize', queueVisibleStackedFilesSync);

        return () => {
            scrollRoot.removeEventListener('scroll', queueVisibleStackedFilesSync);
            window.removeEventListener('resize', queueVisibleStackedFilesSync);
            if (visibleSyncFrameRef.current !== null) {
                window.cancelAnimationFrame(visibleSyncFrameRef.current);
                visibleSyncFrameRef.current = null;
            }
        };
    }, [changedFiles, expandedFiles, queueVisibleStackedFilesSync, visible]);

    const getLayoutForFile = React.useCallback((file: FileEntry): 'inline' | 'side-by-side' => {
        const override = diffFileLayout[file.path];
        if (override) return override;

        if (diffLayoutPreference === 'inline') {
            return 'inline';
        }

        if (diffLayoutPreference === 'side-by-side') {
            return 'side-by-side';
        }

        const isNarrow = screenWidth < SIDE_BY_SIDE_MIN_WIDTH;
        if (file.isNew || isNarrow) {
            return 'inline';
        }

        return 'side-by-side';
    }, [diffFileLayout, diffLayoutPreference, screenWidth]);

    const currentLayoutForAllFiles = React.useMemo<'inline' | 'side-by-side' | null>(() => {
        if (changedFiles.length === 0) return null;
        return changedFiles.every((file) => getLayoutForFile(file) === 'side-by-side')
            ? 'side-by-side'
            : 'inline';
    }, [changedFiles, getLayoutForFile]);

    const registerSectionRef = React.useCallback((path: string, node: HTMLDivElement | null) => {
        const map = fileSectionRefs.current;
        if (node) {
            map.set(path, node);
        } else {
            map.delete(path);
        }
        queueVisibleStackedFilesSyncRef.current();
    }, []);

    const handleStackedEntryExpandedChange = React.useCallback((path: string, expanded: boolean) => {
        cancelPendingScrollAlignment();
        setExpandedFiles((previous) => {
            const hasPath = previous.has(path);
            if (expanded === hasPath) {
                return previous;
            }
            const next = new Set(previous);
            if (expanded) {
                next.add(path);
            } else {
                next.delete(path);
            }
            return next;
        });
        if (!expanded) {
            setMountedStackedFiles((previous) => {
                if (!previous.has(path)) return previous;
                const next = new Set(previous);
                next.delete(path);
                return next;
            });
        }
        queueVisibleStackedFilesSyncRef.current();
    }, [cancelPendingScrollAlignment]);

    const handleExpandOrCollapseAll = React.useCallback(() => {
        cancelPendingScrollAlignment();
        setExpandedFiles((previous) => {
            if (previous.size > 0) {
                return new Set();
            }
            return new Set(changedFiles.map((file) => file.path));
        });
        setMountedStackedFiles(new Set());
        queueVisibleStackedFilesSync();
    }, [cancelPendingScrollAlignment, changedFiles, queueVisibleStackedFilesSync]);

    return { registerSectionRef, handleStackedEntryExpandedChange, handleExpandOrCollapseAll, getLayoutForFile, currentLayoutForAllFiles };
}
