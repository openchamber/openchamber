import React from 'react';
import { normalizePath } from '@/lib/pathNormalization';
import { sessionEvents } from '@/lib/sessionEvents';
import { getRestoredDiffScrollTop } from '../diffScrollAnchor';
import { useDiffViewSetup } from './useDiffViewSetup';


type useDiffViewRefreshProps = Pick<ReturnType<typeof useDiffViewSetup>,
    'effectiveDirectory' | 'setActiveDirectory' | 'ensureStatus' | 'git' | 'runtimeKey' |
    'pendingScrollAnchorRestoreRef' | 'captureScrollAnchor' | 'lastScrollAnchorRef' | 'clearDiffCache' |
    'setFileDiffRefreshNonce' | 'setWorkingTreeRevision' | 'fetchStatus' | 'diffScrollRef' | 'fileSectionRefs' |
    'fileDiffRefreshNonce'
> & {
    visible: boolean;
};

export function useDiffViewRefresh({
    visible, effectiveDirectory, setActiveDirectory, ensureStatus, git, runtimeKey, pendingScrollAnchorRestoreRef,
    captureScrollAnchor, lastScrollAnchorRef, clearDiffCache, setFileDiffRefreshNonce, setWorkingTreeRevision,
    fetchStatus, diffScrollRef, fileSectionRefs, fileDiffRefreshNonce,
}: useDiffViewRefreshProps) {
    // Ensure git status on mount
    React.useEffect(() => {
        if (visible && effectiveDirectory) {
            setActiveDirectory(effectiveDirectory);
            void ensureStatus(effectiveDirectory, git);
        }
    }, [effectiveDirectory, setActiveDirectory, ensureStatus, git, visible]);

    const refreshScope = JSON.stringify([runtimeKey, effectiveDirectory]);
    const deferredRefreshRef = React.useRef({ scope: refreshScope, paths: new Set<string>(), dirty: false, unscoped: false });
    const wasVisibleRef = React.useRef(visible);
    React.useEffect(() => {
        const resumed = visible && !wasVisibleRef.current;
        wasVisibleRef.current = visible;
        if (deferredRefreshRef.current.scope !== refreshScope) {
            deferredRefreshRef.current = { scope: refreshScope, paths: new Set(), dirty: false, unscoped: false };
        }
        if (!effectiveDirectory) {
            return;
        }
        // Named paths bump their entries' revision and an unscoped hint bumps
        // every live diff's; either way the entry refetches in place.
        const refresh = (paths: string[], unscoped: boolean) => {
            if (paths.length) {
                pendingScrollAnchorRestoreRef.current = captureScrollAnchor() ?? lastScrollAnchorRef.current;
                clearDiffCache(effectiveDirectory, paths);
                setFileDiffRefreshNonce((previous) => {
                    const next = new Map(previous);
                    for (const path of paths) {
                        next.set(path, (next.get(path) ?? 0) + 1);
                    }
                    return next;
                });
            }
            if (unscoped) {
                setWorkingTreeRevision((previous) => previous + 1);
            }
            void fetchStatus(effectiveDirectory, git, { silent: true });
        };
        const deferred = deferredRefreshRef.current;
        if (visible && (resumed || deferred.dirty)) {
            refresh([...deferred.paths], deferred.unscoped);
            deferred.paths.clear();
            deferred.dirty = false;
            deferred.unscoped = false;
        }
        return sessionEvents.onGitRefreshHint((hint) => {
            if (normalizePath(hint.directory) !== normalizePath(effectiveDirectory)) return;
            const paths = hint.paths ?? [];
            const unscoped = paths.length === 0;
            if (!visible) {
                deferred.dirty = true;
                deferred.unscoped ||= unscoped;
                for (const path of paths) deferred.paths.add(path);
                return;
            }
            refresh(paths, unscoped);
        });
    }, [captureScrollAnchor, clearDiffCache, effectiveDirectory, fetchStatus, git, refreshScope, visible, lastScrollAnchorRef, setFileDiffRefreshNonce, setWorkingTreeRevision, pendingScrollAnchorRestoreRef]);

    React.useLayoutEffect(() => {
        const anchor = pendingScrollAnchorRestoreRef.current;
        if (!anchor) return;
        pendingScrollAnchorRestoreRef.current = null;

        const scrollRoot = diffScrollRef.current;
        const node = fileSectionRefs.current.get(anchor.path);
        if (!scrollRoot || !node) return;

        const rootTop = scrollRoot.getBoundingClientRect().top;
        const currentTopOffset = node.getBoundingClientRect().top - rootTop;
        scrollRoot.scrollTop = getRestoredDiffScrollTop(
            scrollRoot.scrollTop,
            anchor.topOffset,
            currentTopOffset,
            scrollRoot.scrollHeight - scrollRoot.clientHeight,
        );
        lastScrollAnchorRef.current = anchor;
    }, [fileDiffRefreshNonce, fileSectionRefs, lastScrollAnchorRef, diffScrollRef, pendingScrollAnchorRestoreRef]);

}
