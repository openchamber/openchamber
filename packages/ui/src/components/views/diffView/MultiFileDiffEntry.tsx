import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useGitStore } from '@/stores/useGitStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import { type GitSubmoduleState } from '@/lib/api/types';
import { GitPathUnavailableError } from '@/lib/api/git-path-diff';
import { toast } from '@/components/ui';
import { hasFileVersionsDiff } from '@/lib/toolHelpers';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { DiffViewToggle } from '@/components/chat/message/DiffViewToggle';
import { type DiffViewMode } from '@/components/chat/message/types';
import { type ContextExpansionRequest, type DiffFindWordRequest, type DiffHunkActions, type PierreDiffViewerHandle } from '../PierreDiffViewer';
import { HunkActions, type HunkBusyState, type HunkDiffAction } from '../git/HunkActions';
import { ChangedPathLabel } from '../git/ChangedPathLabel';
import { describeChange } from '../git/changeStatus';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { ToolbarTooltipButton } from '@/components/ui/action-toolbar';
import { ReviewFileMark } from '@/components/review/ReviewFileMark';
import { sessionEvents } from '@/lib/sessionEvents';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { extractHunkPatch, haveMatchingPatchVersions, getPatchHunkAnchors } from '@/lib/diff/patchFileDiff';
import { type DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { useWholeFileComment, WholeFileCommentButton } from '@/components/comments';
import type { FileEntry, DiffContextMode, DiffData, DiffLoadFailure, ComparisonDiffResult, DiffFindReveal } from './types';
import { toAbsolutePath, createTextDiffDataFromPatch, formatDiffTotals } from './diffData';
import { InlineDiffViewer } from './InlineDiffViewer';
import { NestedRepositoryChanges } from './NestedRepositoryChanges';
import { LARGE_DIFF_CHANGED_LINES, FULL_CONTEXT_DIFF_LINES, DEFAULT_CONTEXT_DIFF_LINES } from './diffContextLines';

const DIFF_REQUEST_TIMEOUT_MS = 15000;
const FILE_ACTIONS_MASK = '[mask-image:linear-gradient(to_left,transparent_calc(var(--file-actions-w)_-_0.75rem),#000_calc(var(--file-actions-w)_+_0.75rem))] rtl:[mask-image:linear-gradient(to_right,transparent_calc(var(--file-actions-w)_-_0.75rem),#000_calc(var(--file-actions-w)_+_0.75rem))]';
const FILE_ACTIONS_MASK_CLASS = `${FILE_ACTIONS_MASK} [@media(hover:none)]:![mask-image:none]`;
const FILE_ACTIONS_MASK_ON_REVEAL_CLASS = [
    'group-hover/header:[mask-image:linear-gradient(to_left,transparent_calc(var(--file-actions-w)_-_0.75rem),#000_calc(var(--file-actions-w)_+_0.75rem))]',
    'group-has-[:focus-visible]/header:[mask-image:linear-gradient(to_left,transparent_calc(var(--file-actions-w)_-_0.75rem),#000_calc(var(--file-actions-w)_+_0.75rem))]',
    'rtl:group-hover/header:[mask-image:linear-gradient(to_right,transparent_calc(var(--file-actions-w)_-_0.75rem),#000_calc(var(--file-actions-w)_+_0.75rem))]',
    'rtl:group-has-[:focus-visible]/header:[mask-image:linear-gradient(to_right,transparent_calc(var(--file-actions-w)_-_0.75rem),#000_calc(var(--file-actions-w)_+_0.75rem))]',
    'group-focus-visible/header:[mask-image:linear-gradient(to_left,transparent_calc(var(--file-actions-w)_-_0.75rem),#000_calc(var(--file-actions-w)_+_0.75rem))]',
    'rtl:group-focus-visible/header:[mask-image:linear-gradient(to_right,transparent_calc(var(--file-actions-w)_-_0.75rem),#000_calc(var(--file-actions-w)_+_0.75rem))]',
    '[@media(hover:none)]:![mask-image:none]',
].join(' ');
interface MultiFileDiffEntryProps {
    visible?: boolean;
    directory: string;
    file: FileEntry;
    layout: 'inline' | 'side-by-side';
    wrapLines: boolean;
    hideWhitespace?: boolean;
    isSelected: boolean;
    isExpanded: boolean;
    isMounted: boolean;
    onSelect: (path: string) => void;
    onExpandedChange: (path: string, expanded: boolean) => void;
    registerSectionRef: (path: string, node: HTMLDivElement | null) => void;
    showOpenInEditorAction?: boolean;
    isOpeningInEditor?: boolean;
    onOpenInEditor?: (filePath: string, diffData: DiffData | null) => void;
    staged?: boolean;
    loadFullFiles?: boolean;
    initialDiffData?: DiffData | null;
    comparisonDiff?: ComparisonDiffResult;
    commentOrigin?: DiffCommentOrigin;
    onRetryComparisonDiff?: () => void;
    loadFullComparisonDiff?: (filePath: string) => Promise<ComparisonDiffResult>;
    readOnlyActions?: boolean;
    hunkActionsEnabled?: boolean;
    contentRevision?: number;
    registerViewerRef?: (path: string, handle: PierreDiffViewerHandle | null) => void;
    onFindWordRequest?: (path: string, request: DiffFindWordRequest) => void;
    onFullContextChange?: (path: string, full: boolean) => void;
    findReveal?: DiffFindReveal | null;
    leadingAction?: React.ReactNode;
    extraFileActions?: React.ReactNode;
    hideExpandChevron?: boolean;
}

export const MultiFileDiffEntry = React.memo<MultiFileDiffEntryProps>(({
    visible = true,
    directory,
    file,
    layout,
    wrapLines,
    hideWhitespace = false,
    isSelected,
    isExpanded,
    isMounted,
    onSelect,
    onExpandedChange,
    registerSectionRef,
    showOpenInEditorAction = false,
    isOpeningInEditor = false,
    onOpenInEditor,
    staged = false,
    loadFullFiles: loadAllFullFiles = false,
    initialDiffData = null,
    comparisonDiff: rangeComparisonDiff,
    commentOrigin,
    onRetryComparisonDiff,
    loadFullComparisonDiff,
    readOnlyActions = false,
    hunkActionsEnabled = false,
    contentRevision = 0,
    registerViewerRef,
    onFindWordRequest,
    onFullContextChange,
    findReveal = null,
    leadingAction,
    extraFileActions,
    hideExpandChevron = false,
}) => {
    const { t } = useI18n();
    const { git } = useRuntimeAPIs();
    const wholeFileComment = useWholeFileComment({ fileLabel: file.path, origin: commentOrigin });
    const cachedDiff = useGitStore(
        React.useCallback((state) => {
            return state.directories.get(directory)?.diffCache.get(file.path) ?? null;
        }, [directory, file.path])
    );
    const setDiff = useGitStore((state) => state.setDiff);
    const fetchStatus = useGitStore((state) => state.fetchStatus);
    const setDiffFileLayout = useUIStore((state) => state.setDiffFileLayout);

    const [diffRetryNonce, setDiffRetryNonce] = React.useState(0);
    const [localDiffLoadFailure, setDiffLoadFailure] = React.useState<DiffLoadFailure | null>(null);
    const [isFetching, setIsLoading] = React.useState(false);
    const [fullComparisonDiff, setFullComparisonDiff] = React.useState<{ source: ComparisonDiffResult; result: ComparisonDiffResult } | null>(null);
    const comparisonDiff = fullComparisonDiff !== null && fullComparisonDiff.source === rangeComparisonDiff ? fullComparisonDiff.result : rangeComparisonDiff;
    const canLoadFullFile = Boolean(directory) && !initialDiffData && (!rangeComparisonDiff || Boolean(loadFullComparisonDiff));

    const diffLoadFailure = React.useMemo<DiffLoadFailure | null>(() => {
        if (!comparisonDiff) return localDiffLoadFailure;
        return comparisonDiff.status === 'error' ? { kind: 'error', message: comparisonDiff.message } : null;
    }, [comparisonDiff, localDiffLoadFailure]);
    const isLoading = comparisonDiff ? comparisonDiff.status === 'loading' : isFetching;
    const [hunkAction, setHunkAction] = React.useState<HunkBusyState>(null);
    const mutationInFlight = React.useRef(false);
    const [canonicalPatch, setCanonicalPatch] = React.useState<{ scope: string; patch: string; submodule: GitSubmoduleState | null } | null>(null);
    const [forceRenderLarge, setForceRenderLarge] = React.useState(false);
    const [localDiffData, setLocalDiffData] = React.useState<DiffData | null>(null);
    const [stagedDiffData, setStagedDiffData] = React.useState<DiffData | null>(null);
    const [contextExpansion, setContextExpansion] = React.useState<ContextExpansionRequest | null>(null);
    const loadFullFiles = loadAllFullFiles || contextExpansion !== null;
    React.useEffect(() => {
        if (!loadFullFiles || !onFullContextChange) return;
        onFullContextChange(file.path, true);
        return () => onFullContextChange(file.path, false);
    }, [file.path, loadFullFiles, onFullContextChange]);
    React.useEffect(() => {
        if (findReveal?.key === file.path) setForceRenderLarge(true);
    }, [file.path, findReveal]);
    React.useEffect(() => {
        if (!contextExpansion || !loadFullComparisonDiff || !rangeComparisonDiff || rangeComparisonDiff.status !== 'ready') return;
        if (fullComparisonDiff?.source === rangeComparisonDiff) return;
        let cancelled = false;
        void loadFullComparisonDiff(file.path).then((result) => {
            if (cancelled) return;
            if (result.status === 'error') {
                toast.error(result.message);
                setContextExpansion(null);
                return;
            }
            setFullComparisonDiff({ source: rangeComparisonDiff, result });
        });
        return () => {
            cancelled = true;
        };
    }, [contextExpansion, file.path, fullComparisonDiff, loadFullComparisonDiff, rangeComparisonDiff]);
    const lastDiffRequestRef = React.useRef<string | null>(null);
    const sectionRef = React.useRef<HTMLDivElement | null>(null);

    const descriptor = React.useMemo(() => describeChange(file), [file]);
    const renderSideBySide = layout === 'side-by-side';
    const desiredContextMode: DiffContextMode = loadFullFiles ? 'full' : 'patch';
    const fileStatusKey = `${file.index}:${file.working_dir}:${file.previousPath ?? ''}:${file.insertions}:${file.deletions}`;
    const hunkEligible = hunkActionsEnabled && !readOnlyActions && !initialDiffData && !comparisonDiff && !hasFileVersionsDiff(file.path);
    const patchScope = JSON.stringify([getRuntimeKey(), directory, file.path, staged, fileStatusKey, diffRetryNonce, contentRevision]);
    const actionPatch = canonicalPatch?.scope === patchScope ? canonicalPatch.patch : null;
    const actionSubmodule = canonicalPatch?.scope === patchScope ? canonicalPatch.submodule : null;

    const diffData = React.useMemo<DiffData | null>(() => {
        if (comparisonDiff) return comparisonDiff.status === 'ready' ? comparisonDiff.data : null;
        if (initialDiffData) return initialDiffData;
        if (staged) return stagedDiffData;
        if (localDiffData) return localDiffData;
        if (!cachedDiff) return null;
        return { original: cachedDiff.original, modified: cachedDiff.modified, isBinary: cachedDiff.isBinary, submodule: cachedDiff.submodule, contextMode: 'full' };
    }, [comparisonDiff, cachedDiff, initialDiffData, localDiffData, staged, stagedDiffData]);

    const diffDataMatchesContextMode = diffData?.contextMode === desiredContextMode;
    const renameOnlyDiff = Boolean(
        diffData && file.previousPath && !diffData.isBinary && !diffData.submodule
        && diffData.fileDiff?.hunks.length === 0
    );

    const setSectionRef = React.useCallback((node: HTMLDivElement | null) => {
        sectionRef.current = node;
        registerSectionRef(file.path, node);
    }, [file.path, registerSectionRef]);

    const setViewerRef = React.useCallback((handle: PierreDiffViewerHandle | null) => {
        registerViewerRef?.(file.path, handle);
    }, [file.path, registerViewerRef]);

    const handleFindWordRequest = React.useCallback((request: DiffFindWordRequest) => {
        onFindWordRequest?.(file.path, request);
    }, [file.path, onFindWordRequest]);

    const handleOpenChange = React.useCallback((open: boolean) => {
        onExpandedChange(file.path, open);
    }, [file.path, onExpandedChange]);

    const handleSelect = React.useCallback(() => {
        onSelect(file.path);
    }, [file.path, onSelect]);

    const appliedStagedRef = React.useRef(staged);
    React.useEffect(() => {
        if (appliedStagedRef.current === staged) return;
        appliedStagedRef.current = staged;
        if (!staged) {
            setLocalDiffData(null);
        } else {
            setStagedDiffData(null);
        }

        setDiffLoadFailure(null);
        lastDiffRequestRef.current = null;
    }, [staged]);

    const diffVersion = `${contentRevision}:${fileStatusKey}`;
    const [loadedVersion, setLoadedVersion] = React.useState(diffVersion);
    const isDiffCurrent = loadedVersion === diffVersion;
    React.useEffect(() => {
        if (isDiffCurrent) return;
        setDiffLoadFailure(null);
        lastDiffRequestRef.current = null;
    }, [isDiffCurrent]);

    React.useEffect(() => {
        if (!visible || !isExpanded || !isMounted) return;
        if (localDiffLoadFailure) return;
        if (!directory || comparisonDiff || initialDiffData || (diffData && diffDataMatchesContextMode && isDiffCurrent && (!hunkEligible || actionPatch !== null))) {
            lastDiffRequestRef.current = null;
            setIsLoading(false);
            return;
        }

        const requestKey = `${directory}::${file.path}::${staged ? 'staged' : 'unstaged'}::${fileStatusKey}::${desiredContextMode}::${diffRetryNonce}::${contentRevision}`;
        if (lastDiffRequestRef.current === requestKey) {
            return;
        }
        lastDiffRequestRef.current = requestKey;
        setDiffLoadFailure(null);
        setIsLoading(true);

        let cancelled = false;
        const runtimeKey = getRuntimeKey();
        const contextLines = loadFullFiles ? FULL_CONTEXT_DIFF_LINES : DEFAULT_CONTEXT_DIFF_LINES;
        const displayRequest = !git.getGitFileDiff || !git.getGitDiff
            ? Promise.reject(new Error(t('diffView.unavailable.missingTitle')))
            : hasFileVersionsDiff(file.path)
                ? git.getGitFileDiff(directory, { path: file.path, staged, previousPath: file.previousPath })
                : !loadFullFiles && actionPatch !== null
                    ? Promise.resolve({ diff: actionPatch, submodule: actionSubmodule })
            : git.getGitDiff(directory, { path: file.path, staged, contextLines, previousPath: file.previousPath });
        const canonicalRequest = hunkEligible && loadFullFiles && actionPatch === null && git.getGitDiff
            ? git.getGitDiff(directory, { path: file.path, staged, contextLines: DEFAULT_CONTEXT_DIFF_LINES, previousPath: file.previousPath }).then((response) => response.diff)
            : Promise.resolve(actionPatch);
        const fetchPromise = Promise.all([displayRequest, canonicalRequest]);
        const timeoutMs = DIFF_REQUEST_TIMEOUT_MS;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
        });

        void Promise.race([fetchPromise, timeoutPromise])
            .then(([response, normalPatch]) => {
                if (cancelled || runtimeKey !== getRuntimeKey()) return;

                const patch = 'diff' in response && !loadFullFiles ? response.diff : normalPatch;
                if (hunkEligible && loadFullFiles && patch !== null && /^@@\s/m.test(patch)
                    && ('diff' in response && response.diff !== patch && !haveMatchingPatchVersions(response.diff, patch))) {
                    setCanonicalPatch(null);
                    throw new Error(t('diffView.hunk.unavailable'));
                }
                if (hunkEligible && patch !== null) setCanonicalPatch({ scope: patchScope, patch, submodule: response.submodule });

                if ('diff' in response) {
                    const nextDiff = { ...createTextDiffDataFromPatch(file.path, response.diff, desiredContextMode), submodule: response.submodule };
                    if (staged) {
                        setStagedDiffData(nextDiff);
                    } else {
                        setLocalDiffData(nextDiff);
                    }
                } else {
                    const nextDiff = {
                        original: response.original ?? '',
                        modified: response.modified ?? '',
                        isBinary: response.isBinary,
                        submodule: response.submodule,
                        contextMode: 'full' as const,
                    };
                    if (staged) {
                        setStagedDiffData(nextDiff);
                    } else {
                        setDiff(directory, file.path, nextDiff, runtimeKey);
                        setLocalDiffData(nextDiff);
                    }
                }
                setLoadedVersion(diffVersion);
                setIsLoading(false);
            })
            .catch((error) => {
                if (cancelled || runtimeKey !== getRuntimeKey()) return;
                setIsLoading(false);
                if (error instanceof GitPathUnavailableError) {
                    setDiffLoadFailure({ kind: 'unavailable', reason: error.reason });
                    if (error.reason === 'path_not_found') void fetchStatus(directory, git, { force: true, silent: true });
                    return;
                }
                setDiffLoadFailure({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
            }).finally(() => clearTimeout(timeout));

        return () => {
            cancelled = true;
            clearTimeout(timeout);
            if (lastDiffRequestRef.current === requestKey) {
                lastDiffRequestRef.current = null;
            }
        };
    }, [actionPatch, actionSubmodule, contentRevision, diffVersion, hunkEligible, isDiffCurrent, patchScope, comparisonDiff, desiredContextMode, diffData, diffDataMatchesContextMode, diffRetryNonce, directory, fetchStatus, file.path, file.previousPath, fileStatusKey, git, initialDiffData, isExpanded, isMounted, loadFullFiles, localDiffLoadFailure, setDiff, staged, t, visible]);

    const handleToggle = React.useCallback(() => {
        handleOpenChange(!isExpanded);
        handleSelect();
    }, [handleOpenChange, handleSelect, isExpanded]);

    const invalidatePatch = React.useCallback(() => {
        setDiffLoadFailure(null);
        setCanonicalPatch(null);
        setLocalDiffData(null);
        setStagedDiffData(null);
        lastDiffRequestRef.current = null;
        setDiffRetryNonce((nonce) => nonce + 1);
    }, []);

    const discardConfirm = useConfirmDialog();
    const { confirm: confirmDiscard } = discardConfirm;
    const handleHunkAction = React.useCallback(async (hunkIndex: number, action: HunkDiffAction) => {
        if (!directory || !hunkEligible || isLoading || diffLoadFailure || mutationInFlight.current || hunkAction !== null) {
            return;
        }

        const hunkPatch = actionPatch ? extractHunkPatch(actionPatch, hunkIndex) : null;
        if (!hunkPatch) {
            toast.error(t('diffView.hunk.unavailable'));
            return;
        }

        if ((staged && action !== 'unstage') || (!staged && action === 'unstage')) return;
        if (action === 'discard' && !await confirmDiscard({
            title: t('diffView.hunk.discardDialogTitle'),
            message: t('diffView.hunk.discardDescription', { path: file.path }),
            action: t('diffView.hunk.discard'),
            destructive: true,
        })) return;
        if (mutationInFlight.current) return;
        mutationInFlight.current = true;
        const runtimeKey = getRuntimeKey();
        setHunkAction({ index: hunkIndex, action });
        try {
            const hunkMutation = action === 'stage'
                ? git.stageGitHunk
                : action === 'unstage'
                    ? git.unstageGitHunk
                    : git.revertGitHunk;
            if (!hunkMutation) {
                toast.error(t('diffView.hunk.unsupported'));
                return;
            }
            await hunkMutation(directory, file.path, hunkPatch);
            if (runtimeKey !== getRuntimeKey()) return;
            invalidatePatch();
            sessionEvents.requestGitRefresh({ directory, paths: [file.path] });
            await fetchStatus(directory, git);
        } catch (error) {
            if (runtimeKey !== getRuntimeKey()) return;
            invalidatePatch();
            toast.error(error instanceof Error && error.message ? error.message : t('diffView.hunk.unavailable'));
        } finally {
            mutationInFlight.current = false;
            setHunkAction((current) => (current?.index === hunkIndex && current.action === action ? null : current));
        }
    }, [actionPatch, confirmDiscard, hunkEligible, isLoading, diffLoadFailure, directory, fetchStatus, file.path, git, hunkAction, invalidatePatch, staged, t]);

    const hunkAnchors = React.useMemo(() => hunkEligible && actionPatch !== null ? getPatchHunkAnchors(actionPatch) : [], [actionPatch, hunkEligible]);
    const renderHunkActions = React.useCallback((index: number, revealed: boolean) => (
        <HunkActions index={index} revealed={revealed} staged={staged} busyHunk={hunkAction}
            disabled={isLoading || Boolean(diffLoadFailure)} onAction={handleHunkAction} />
    ), [diffLoadFailure, handleHunkAction, hunkAction, isLoading, staged]);
    const diffHunkActions = React.useMemo<DiffHunkActions | undefined>(() => hunkAnchors.length > 0
        ? { anchors: hunkAnchors, render: renderHunkActions } : undefined, [hunkAnchors, renderHunkActions]);

    const actionsPinned = wholeFileComment.isOpen || isOpeningInEditor;
    const { hasTouchOnlyPointer } = useDeviceInfo();
    const [actionsArmed, setActionsArmed] = React.useState(false);
    const armActions = React.useCallback(() => setActionsArmed(true), []);
    const [fileActionsElement, setFileActionsElement] = React.useState<HTMLSpanElement | null>(null);
    React.useLayoutEffect(() => {
        if (!fileActionsElement) return;
        const observer = new ResizeObserver((entries) => {
            const width = entries[entries.length - 1]?.borderBoxSize?.[0]?.inlineSize;
            if (width !== undefined) fileActionsElement.parentElement?.style.setProperty('--file-actions-w', `${Math.ceil(width)}px`);
        });
        observer.observe(fileActionsElement);
        return () => observer.disconnect();
    }, [fileActionsElement]);
    const fileActions = (
        <>
            {showOpenInEditorAction && onOpenInEditor ? (
                <ToolbarTooltipButton
                    label={t('diffView.actions.openFileInEditorAtChange')}
                    icon={isOpeningInEditor ? 'loader-4' : 'edit'}
                    iconClassName={isOpeningInEditor ? 'animate-spin' : undefined}
                    onClick={(event) => {
                        event.stopPropagation();
                        onOpenInEditor(file.path, diffData);
                    }}
                    disabled={isOpeningInEditor}
                />
            ) : null}
            <WholeFileCommentButton
                onClick={wholeFileComment.toggle}
                active={wholeFileComment.isOpen}
            />
            <DiffViewToggle
                mode={renderSideBySide ? 'side-by-side' : 'unified'}
                onModeChange={(mode: DiffViewMode) => {
                    const nextLayout: 'inline' | 'side-by-side' =
                        mode === 'side-by-side' ? 'side-by-side' : 'inline';
                    setDiffFileLayout(file.path, nextLayout);
                }}
            />
            {extraFileActions}
        </>
    );

    return (
        <div ref={setSectionRef} className="scroll-mt-9">
            <div className={cn(
                isExpanded
                    ? 'sticky top-0 z-30 bg-[var(--surface-elevated)]/90 backdrop-blur-md supports-[backdrop-filter]:bg-[var(--surface-elevated)]/80'
                    : 'relative',
            )}>
                <div
                    role="button"
                    tabIndex={0}
                    onClick={handleToggle}
                    onPointerEnter={armActions}
                    onFocus={armActions}
                    onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            handleToggle();
                        }
                    }}
                    className={cn(
                        'cursor-pointer',
                        'group/header relative isolate flex min-h-8 w-full min-w-0 items-center overflow-hidden px-3 py-1.5',
                        'bg-transparent',
                        'text-muted-foreground hover:text-foreground',
                        isSelected ? 'bg-[var(--interactive-selection)]/35' : null
                    )}
                >
                    <div className="absolute inset-0 -z-10 pointer-events-none group-hover/header:bg-[var(--interactive-hover)]/50" />
                    <div className={cn(
                        'grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-2',
                        actionsPinned ? FILE_ACTIONS_MASK_CLASS : FILE_ACTIONS_MASK_ON_REVEAL_CLASS,
                    )}>
                    <div className="relative flex min-w-0 flex-1 items-center gap-2">
                        {leadingAction}
                        {!hideExpandChevron && (
                            <span className="flex size-5 items-center justify-center opacity-70 group-hover/header:opacity-100">
                                {isExpanded ? (
                                    <Icon name="arrow-down-s" className="size-4" />
                                ) : (
                                    <Icon name="arrow-right-s" className="size-4" />
                                )}
                            </span>
                        )}
                        <span
                            className="typography-micro font-semibold leading-none w-4 text-center uppercase"
                            style={{ color: descriptor.color }}
                            title={t(descriptor.descriptionKey)}
                            aria-label={t(descriptor.descriptionKey)}
                        >
                            {descriptor.code}
                        </span>
                        <span
                            className="min-w-0 flex-1 overflow-hidden typography-ui-label"
                        >
                            <span className="flex min-w-0 items-center gap-2">
                                <FileTypeIcon filePath={file.path} className="h-3.5 w-3.5 flex-shrink-0 align-middle" />
                                <ChangedPathLabel
                                    path={file.path}
                                    from={file.previousPath}
                                    className="typography-ui-label"
                                />
                            </span>
                        </span>
                    </div>
                    <div className="flex shrink-0 items-center justify-self-end gap-2">
                        <ReviewFileMark path={file.path} />
                        {formatDiffTotals(file.insertions, file.deletions)}
                        {hasTouchOnlyPointer ? <span className="hidden items-center gap-2 [@media(hover:none)]:flex">{fileActions}</span> : null}
                    </div>
                    </div>
                    <span
                        ref={setFileActionsElement}
                        className={cn(
                            'absolute inset-y-0 end-0 z-10 flex items-center gap-2 pe-3 transition-opacity [@media(hover:none)]:hidden',
                            actionsPinned
                                ? 'opacity-100'
                                : 'pointer-events-none opacity-0 group-hover/header:pointer-events-auto group-hover/header:opacity-100 group-has-[:focus-visible]/header:pointer-events-auto group-has-[:focus-visible]/header:opacity-100 group-focus-visible/header:pointer-events-auto group-focus-visible/header:opacity-100',
                        )}
                    >
                        {actionsArmed || actionsPinned ? fileActions : null}
                    </span>
                </div>
                {wholeFileComment.editor}
            </div>
            {wholeFileComment.cards}
            {isExpanded && (
                <div className="relative bg-background overflow-clip">
                    {!isMounted && !diffLoadFailure ? (
                        <div className="h-40 border border-edge-muted bg-background/40" />
                    ) : null}
                    {diffLoadFailure?.kind === 'unavailable' && diffLoadFailure.reason === 'nested_repository' ? (
                        <NestedRepositoryChanges
                            directory={toAbsolutePath(directory, file.path)}
                            revision={contentRevision}
                            renderSideBySide={renderSideBySide}
                            wrapLines={wrapLines}
                            hideWhitespace={hideWhitespace}
                            findKeyPrefix={file.path}
                            registerViewerRef={registerViewerRef}
                            onFindWordRequest={onFindWordRequest}
                            findReveal={findReveal}
                        />
                    ) : null}
                    {diffLoadFailure?.kind === 'unavailable' && diffLoadFailure.reason !== 'nested_repository' ? (
                        <div className="flex flex-col items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
                            <div className="typography-ui-label font-semibold text-foreground">
                                {diffLoadFailure.reason === 'untracked_directory'
                                    ? t('diffView.unavailable.untrackedDirectoryTitle')
                                    : t('diffView.unavailable.missingTitle')}
                            </div>
                            <div className="typography-meta text-muted-foreground max-w-[32rem] text-center">
                                {diffLoadFailure.reason === 'untracked_directory'
                                    ? t('diffView.unavailable.untrackedDirectoryDescription')
                                    : t('diffView.unavailable.missingDescription')}
                            </div>
                            {diffLoadFailure.reason === 'path_not_found' ? (
                                <button
                                    type="button"
                                    className="typography-ui-label text-primary hover:underline"
                                    onClick={invalidatePatch}
                                >
                                    {t('diffView.actions.retry')}
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                    {diffLoadFailure?.kind === 'error' ? (
                        <div className="flex flex-col items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
                            <div className="typography-ui-label font-semibold text-foreground">
                                {t('diffView.state.failedToLoadDiff')}
                            </div>
                            <div className="typography-meta text-muted-foreground max-w-[32rem] text-center">
                                {diffLoadFailure.message}
                            </div>
                            <button
                                type="button"
                                className="typography-ui-label text-primary hover:underline"
                                onClick={() => comparisonDiff ? onRetryComparisonDiff?.() : invalidatePatch()}
                            >
                                {t('diffView.actions.retry')}
                            </button>
                        </div>
                    ) : null}
                    {isMounted && isLoading && !diffData && !diffLoadFailure ? (
                        <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
                            <Icon name="loader-4" className="size-4 animate-spin" />
                            {t('diffView.state.loadingDiff')}
                        </div>
                    ) : null}
                    {isMounted && diffData && !forceRenderLarge && (file.insertions + file.deletions) > LARGE_DIFF_CHANGED_LINES ? (
                        <div className="flex flex-col items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
                            <div className="typography-ui-label font-semibold text-foreground">
                                {t('diffView.state.largeDiff', { count: file.insertions + file.deletions })}
                            </div>
                            <div className="typography-meta text-muted-foreground">
                                {t('diffView.state.largeDiffDescription')}
                            </div>
                            <button
                                type="button"
                                className="typography-ui-label text-primary hover:underline"
                                onClick={() => setForceRenderLarge(true)}
                            >
                                {t('diffView.actions.renderAnyway')}
                            </button>
                        </div>
                    ) : null}
                    {isMounted && renameOnlyDiff ? (
                        <div className="px-4 py-3 typography-meta text-muted-foreground">
                            {t('diffView.change.renamedFrom', { from: file.previousPath ?? '' })}
                        </div>
                    ) : null}
                    {isMounted && diffData && !renameOnlyDiff && (forceRenderLarge || (file.insertions + file.deletions) <= LARGE_DIFF_CHANGED_LINES) ? (
                        <>
                            <InlineDiffViewer
                                filePath={file.path}
                                diff={diffData}
                                commentOrigin={commentOrigin}
                                staged={staged}
                                renderSideBySide={renderSideBySide}
                                wrapLines={wrapLines}
                                hideWhitespace={hideWhitespace}
                                hunkActions={diffHunkActions}
                                onExpandContextRequest={canLoadFullFile ? setContextExpansion : undefined}
                                pendingContextExpansion={contextExpansion}
                                contextLoading={contextExpansion !== null && diffData.contextMode !== 'full' && !diffLoadFailure}
                                viewerRef={setViewerRef}
                                onFindWordRequest={handleFindWordRequest}
                            />
                        </>
                    ) : null}
                </div>
            )}
            {discardConfirm.dialog}
        </div>
    );
});
