import React from 'react';
import { findDiffScrollAnchor } from '../diffScrollAnchor';
import type { FileEntry } from './types';
import { useDiffViewSetup } from './useDiffViewSetup';
import { useDiffViewComparisons } from './useDiffViewComparisons';

// Minimum width for side-by-side diff view (px)
const SIDE_BY_SIDE_MIN_WIDTH = 1100;
const STACKED_DIFF_MOUNT_MARGIN = 300;
// Perf: limit concurrent expanded diffs in stacked view.
// Expanding many diffs mounts many Pierre instances + lots of DOM.
const getStackedViewDefaultExpandedCount = (fileCount: number): number => {
    if (fileCount <= 6) return fileCount;
    if (fileCount <= 12) return 6;
    if (fileCount <= 25) return 4;
    return 2;
};

type useDiffViewStackedViewportProps = Pick<ReturnType<typeof useDiffViewSetup>,
    'effectiveDirectory' | 'activeDiffScope' | 'stackedStateScopeRef' | 'setExpandedFiles' | 'setMountedStackedFiles' |
    'visibleSyncFrameRef' | 'diffScrollRef' | 'fileSectionRefs' | 'expandedFiles' | 'lastScrollAnchorRef' |
    'diffFileLayout' | 'diffLayoutPreference' | 'screenWidth'
> & Pick<ReturnType<typeof useDiffViewComparisons>,
    'changedFilePathsKey' | 'changedFiles'
> & {
    stackedDefaultCollapsedAll: boolean;
    visible: boolean;
};

export function useDiffViewStackedViewport({
    changedFilePathsKey, effectiveDirectory, activeDiffScope, stackedDefaultCollapsedAll, stackedStateScopeRef,
    setExpandedFiles, setMountedStackedFiles, visibleSyncFrameRef, visible, diffScrollRef, fileSectionRefs,
    expandedFiles, lastScrollAnchorRef, changedFiles, diffFileLayout, diffLayoutPreference, screenWidth,
}: useDiffViewStackedViewportProps) {
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
                return new Set(paths.slice(0, defaultExpandedCount));
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
    }, [activeDiffScope, changedFilePathsKey, effectiveDirectory, stackedDefaultCollapsedAll, setMountedStackedFiles, stackedStateScopeRef, setExpandedFiles]);

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
    }, [expandedFiles, visible, fileSectionRefs, visibleSyncFrameRef, setMountedStackedFiles, lastScrollAnchorRef, diffScrollRef]);

    const queueVisibleStackedFilesSync = React.useCallback(() => {
        if (!visible) return;
        if (typeof window === 'undefined') return;
        if (visibleSyncFrameRef.current !== null) return;
        visibleSyncFrameRef.current = window.requestAnimationFrame(syncVisibleStackedFiles);
    }, [syncVisibleStackedFiles, visible, visibleSyncFrameRef]);
    // The file entries' callbacks reach the sync through this ref, so they
    // keep their identity when the view is shown or hidden: a new callback
    // re-rendered every entry (150 of them in a large change) on each open.
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
    }, [changedFiles, expandedFiles, queueVisibleStackedFilesSync, visible, diffScrollRef, visibleSyncFrameRef]);

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

    return { queueVisibleStackedFilesSync, queueVisibleStackedFilesSyncRef, getLayoutForFile, currentLayoutForAllFiles };
}
