import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import { useInContextPanelHeader } from '@/components/layout/contextPanelHeaderSlotContext';
import { useGitStore, useGitStatus, useIsGitRepo, useGitLoadingStatus } from '@/stores/useGitStore';
import { DIFF_TOOLBAR_MENU_STEPS, useDiffToolbarFit } from '@/components/views/useDiffToolbarFit';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDeviceInfo } from '@/lib/device';
import { findDiffScrollAnchor, type DiffScrollAnchor } from '../diffScrollAnchor';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useWalkthroughStore } from '@/stores/useWalkthroughStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import type { DiffScope } from './types';

/** View options of the diff toolbar: in its "More actions" menu at every width. */
const DIFF_TOOLBAR_VIEW_OPTIONS = ['tree', 'wrap', 'whitespace', 'layout'] as const;
export type DiffToolbarMenuOption = 'walkthrough' | typeof DIFF_TOOLBAR_VIEW_OPTIONS[number];

type useDiffViewSetupProps = {
    targetDirectory: string | null;
    visible: boolean;
    diffScope: DiffScope | null;
    hideStackedFileSidebar: boolean;
};

export function useDiffViewSetup({ targetDirectory, visible, diffScope, hideStackedFileSidebar }: useDiffViewSetupProps) {
    const { t } = useI18n();
    const inPanelHeader = useInContextPanelHeader();
    const toolbarRef = React.useRef<HTMLDivElement | null>(null);
    useDiffToolbarFit(toolbarRef);
    // "More actions": the view options, set now and then and so kept out of
    // the row at every width, plus the walkthrough while the fit has moved it
    // there (an attribute on the row, read when the menu opens).
    const [toolbarMenuOptions, setToolbarMenuOptions] = React.useState<ReadonlyArray<DiffToolbarMenuOption>>(DIFF_TOOLBAR_VIEW_OPTIONS);
    const handleToolbarMenuOpenChange = React.useCallback((open: boolean) => {
        if (!open) return;
        const walkthroughMoved = toolbarRef.current?.hasAttribute(DIFF_TOOLBAR_MENU_STEPS.walkthrough) ?? false;
        setToolbarMenuOptions(walkthroughMoved ? ['walkthrough', ...DIFF_TOOLBAR_VIEW_OPTIONS] : DIFF_TOOLBAR_VIEW_OPTIONS);
    }, []);
    const { git, files, sourceControl } = useRuntimeAPIs();
    const panelDirectory = useEffectiveDirectory();
    const foreign = Boolean(targetDirectory);
    const rootDirectory = targetDirectory ?? panelDirectory;
    const runtimeKey = useGitStore((state) => state.runtimeKey);
    // Diffs belong to the repository being diffed: the picked one, or the
    // root when nothing is picked.
    const {
        gitDirectory: nestedGitDirectory, rootIsGitRepo, repositoryOptions, repositoriesKnown,
        unreadable } = useNestedGitDirectory(rootDirectory ?? null, { enabled: visible, recheckOnOpen: true,
    });
    const effectiveDirectory = nestedGitDirectory ?? rootDirectory;
    // The binding follows the repository actually being diffed.
    const binding = useRepositoryBinding(effectiveDirectory, sourceControl);
    const openContextSurface = useUIStore((state) => state.openContextSurface);
    const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
    const requestWalkthroughTarget = useWalkthroughStore((state) => state.requestTarget);
    const { screenWidth, isMobile } = useDeviceInfo();

    const isGitRepo = useIsGitRepo(effectiveDirectory ?? null);
    const status = useGitStatus(effectiveDirectory ?? null);
    const isLoadingStatus = useGitLoadingStatus(effectiveDirectory ?? null);
    const setActiveDirectory = useGitStore((state) => state.setActiveDirectory);
    const ensureStatus: (directory: string, git: ReturnType<typeof useRuntimeAPIs>['git']) => Promise<void> = useGitStore((state) => state.ensureStatus);
    const selectNestedRepo = useGitStore((state) => state.selectNestedRepo);
    const fetchStatus: (directory: string, git: ReturnType<typeof useRuntimeAPIs>['git'], options?: Parameters<ReturnType<typeof useGitStore.getState>['fetchStatus']>[2]) => Promise<boolean> = useGitStore((state) => state.fetchStatus);
    const fetchBranches: (directory: string, git: ReturnType<typeof useRuntimeAPIs>['git'], options?: Parameters<ReturnType<typeof useGitStore.getState>['fetchBranches']>[2]) => Promise<void> = useGitStore((state) => state.fetchBranches);
    const clearDiffCache = useGitStore((state) => state.clearDiffCache);
    const setDiff = useGitStore((state) => state.setDiff);
    const [displayFile, setDisplayFile] = React.useState<string | null>(null);
    const [displayFileStaged, setDisplayFileStaged] = React.useState(false);
    // A file the last turn's diff did not have, on its way to Changed. The
    // repository is picked for it once, and its status read once per repository.
    const [changedFallback, setChangedFallback] = React.useState<{ file: string; picked: boolean; statusReadFor: string | null } | null>(null);
    const fallbackStatusRequestRef = React.useRef<string | null>(null);
    const [pinnedStackedTarget, setPinnedStackedTarget] = React.useState<string | null>(null);
    const [expandedFiles, setExpandedFiles] = React.useState<Set<string>>(() => new Set());
    const [mountedStackedFiles, setMountedStackedFiles] = React.useState<Set<string>>(() => new Set());
    const [scrollRequestNonce, setScrollRequestNonce] = React.useState(0);
    const [fileDiffRefreshNonce, setFileDiffRefreshNonce] = React.useState<Map<string, number>>(() => new Map());
    // A tool completion says "something in this directory changed" without
    // naming paths; every live diff on screen may be stale even when the
    // status row it hangs off did not move.
    const [workingTreeRevision, setWorkingTreeRevision] = React.useState(0);
    const [reviewDialogOpen, setReviewDialogOpen] = React.useState(false);
    // With no view picked, Changes opens on Branch and waits there for the
    // base; it falls back to Changed only once the branch has none, so the
    // view never switches under the person a moment after it opened.
    const [activeDiffScope, setActiveDiffScope] = React.useState<DiffScope>(
        diffScope === null && !isVSCodeRuntime() ? 'branch' : diffScope ?? 'working'
    );

    React.useEffect(() => {
        if (diffScope !== null) setActiveDiffScope(diffScope);
    }, [diffScope]);

    const pendingDiffFile = useUIStore((state) => state.pendingDiffFile);
    const pendingDiffStaged = useUIStore((state) => state.pendingDiffStaged);
    const pendingDiffScope = useUIStore((state) => state.pendingDiffScope);
    const setPendingDiffFile = useUIStore((state) => state.setPendingDiffFile);
    const pendingTurnDiffFile = useUIStore((state) => state.pendingTurnDiffFile);
    const setPendingTurnDiffFile = useUIStore((state) => state.setPendingTurnDiffFile);
    const diffLayoutPreference = useUIStore((state) => state.diffLayoutPreference);
    const diffFileLayout = useUIStore((state) => state.diffFileLayout);
    const setDiffLayoutForAllFiles = useUIStore((state) => state.setDiffLayoutForAllFiles);
    const diffWrapLinesStore = useUIStore((state) => state.diffWrapLines);
    const setDiffWrapLines = useUIStore((state) => state.setDiffWrapLines);
    const diffHideWhitespace = useUIStore((state) => state.diffHideWhitespace);
    const setDiffHideWhitespace = useUIStore((state) => state.setDiffHideWhitespace);
    const diffFileListMode = useUIStore((state) => state.diffFileListMode);
    const setDiffFileListMode = useUIStore((state) => state.setDiffFileListMode);
    const openContextFileAtLine = useUIStore((state) => state.openContextFileAtLine);
    // Another project's PR has nothing to do with the session on screen.
    const panelSessionId = useSessionUIStore((state) => state.currentSessionId);
    const currentSessionId = foreign ? null : panelSessionId;
    const diffWrapLines = diffWrapLinesStore;
    const forcedStaged = activeDiffScope === 'staged' ? true : activeDiffScope === 'working' ? false : null;
    const activeDiffStaged = forcedStaged ?? displayFileStaged;

    const isMobileLayout = isMobile || screenWidth <= 768;
    const showReviewAction = Boolean(currentSessionId) && activeDiffScope !== 'turn' && activeDiffScope !== 'commit' && activeDiffScope !== 'pr' && !isMobileLayout && !isVSCodeRuntime();
    // Same runtime and width rules as the rail surface: no point offering an
    // entry point to a surface that cannot open here.
    const showWalkthroughAction = activeDiffScope !== 'turn' && !isMobileLayout && !isVSCodeRuntime();
    const showFileSidebar = !hideStackedFileSidebar && !isMobileLayout && screenWidth >= 1024;
    const diffScrollRef = React.useRef<HTMLElement | null>(null);
    const diffRootRef = React.useRef<HTMLDivElement | null>(null);
    const fileSectionRefs = React.useRef(new Map<string, HTMLDivElement | null>());
    const pendingScrollTargetRef = React.useRef<string | null>(null);
    const pendingScrollFrameRef = React.useRef<number | null>(null);
    const shouldPinAfterAlignRef = React.useRef(false);
    const visibleSyncFrameRef = React.useRef<number | null>(null);
    const stackedStateScopeRef = React.useRef<string | null>(null);
    const lastScrollAnchorRef = React.useRef<DiffScrollAnchor | null>(null);
    const pendingScrollAnchorRestoreRef = React.useRef<DiffScrollAnchor | null>(null);

    const captureScrollAnchor = React.useCallback((): DiffScrollAnchor | null => {
        const scrollRoot = diffScrollRef.current;
        if (!scrollRoot) return null;

        const rootTop = scrollRoot.getBoundingClientRect().top;
        const sections: Array<{ path: string; top: number }> = [];
        for (const [path, node] of fileSectionRefs.current) {
            if (node) sections.push({ path, top: node.getBoundingClientRect().top });
        }
        return findDiffScrollAnchor(rootTop, sections);
    }, []);

    const cancelPendingScrollAlignment = React.useCallback(() => {
        pendingScrollTargetRef.current = null;
        shouldPinAfterAlignRef.current = false;
        setPinnedStackedTarget(null);
        if (pendingScrollFrameRef.current !== null) {
            window.cancelAnimationFrame(pendingScrollFrameRef.current);
            pendingScrollFrameRef.current = null;
        }
    }, []);

    const expandStackedFile = React.useCallback((path: string) => {
        setExpandedFiles((previous) => {
            if (previous.has(path)) {
                return previous;
            }
            const next = new Set(previous);
            next.add(path);
            return next;
        });
    }, []);


    return {
        t, inPanelHeader, toolbarRef, toolbarMenuOptions, handleToolbarMenuOpenChange, git, files, panelDirectory,
        foreign, rootDirectory, runtimeKey, nestedGitDirectory, rootIsGitRepo, repositoryOptions, repositoriesKnown,
        unreadable, effectiveDirectory, binding, openContextSurface, openContextPanelTab, requestWalkthroughTarget,
        screenWidth, isMobile, isGitRepo, status, isLoadingStatus, setActiveDirectory, ensureStatus, selectNestedRepo,
        fetchStatus, fetchBranches, clearDiffCache, setDiff, displayFile, setDisplayFile, displayFileStaged,
        setDisplayFileStaged, changedFallback, setChangedFallback, fallbackStatusRequestRef, pinnedStackedTarget,
        setPinnedStackedTarget, expandedFiles, setExpandedFiles, mountedStackedFiles, setMountedStackedFiles,
        scrollRequestNonce, setScrollRequestNonce, fileDiffRefreshNonce, setFileDiffRefreshNonce, workingTreeRevision,
        setWorkingTreeRevision, reviewDialogOpen, setReviewDialogOpen, activeDiffScope, setActiveDiffScope,
        pendingDiffFile, pendingDiffStaged, pendingDiffScope, setPendingDiffFile, pendingTurnDiffFile,
        setPendingTurnDiffFile, diffLayoutPreference, diffFileLayout, setDiffLayoutForAllFiles, diffWrapLinesStore,
        setDiffWrapLines, diffHideWhitespace, setDiffHideWhitespace, diffFileListMode, setDiffFileListMode,
        openContextFileAtLine, currentSessionId, diffWrapLines, forcedStaged, activeDiffStaged, isMobileLayout,
        showReviewAction, showWalkthroughAction, showFileSidebar, diffScrollRef, diffRootRef, fileSectionRefs,
        pendingScrollTargetRef, pendingScrollFrameRef, shouldPinAfterAlignRef, visibleSyncFrameRef, stackedStateScopeRef,
        lastScrollAnchorRef, pendingScrollAnchorRestoreRef, captureScrollAnchor, cancelPendingScrollAlignment,
        expandStackedFile,
    };
}
