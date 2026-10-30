import React from 'react';

import { useUIStore, type PendingDiffScope } from '@/stores/useUIStore';
import { useCommitComparison } from '@/hooks/useCommitComparison';
import { usePullRequestComparison } from '@/hooks/usePullRequestComparison';
import { PullRequestComparisonSelector } from '@/components/views/git/PullRequestComparisonSelector';
import { ChangeRequestDiffUnavailable } from '@/components/views/git/ChangeRequestDiffUnavailable';
import { ChangeScopeSelector } from './ChangeScopeSelector';
import { useGitComparison, type GitComparisonSource } from '@/hooks/useGitComparison';
import { CommitComparisonSelector } from '@/components/views/git/CommitComparisonSelector';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import { NestedRepoPicker } from '@/components/views/git/NestedRepoPicker';
import { ContextPanelHeaderToolbar } from '@/components/layout/contextPanelHeaderSlot';
import { useInContextPanelHeader } from '@/components/layout/contextPanelHeaderSlotContext';
import { BranchComparisonSelector } from '@/components/views/git/BranchComparisonSelector';
import { branchRefLabel } from '@/components/views/git/baseBranch';
import { useGitStore, useGitStatus, useIsGitRepo, useGitLoadingStatus } from '@/stores/useGitStore';
import { useGitBaseBranchStore } from '@/stores/useGitBaseBranchStore';
import { useBranchComparisonBase } from '@/hooks/useBranchComparisonBase';
import { useBranchPullRequestRequest } from '@/hooks/useBranchPullRequestRequest';
import { DIFF_TOOLBAR_MENU_STEPS, useDiffToolbarFit } from '@/components/views/useDiffToolbarFit';
import { branchPathRevisions, coerceDiffScope, isBranchScopeAvailable, isBranchScopeDefinitelyUnavailable, useRangeKeyedCache, useBoundedDirectoryRetry } from './branchDiffScope';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import { normalizePath } from '@/lib/pathNormalization';
import type { GitPathDiffBatchEntry, GitStatus, GitSubmoduleState } from '@/lib/api/types';
import { GitPathUnavailableError, type GitPathUnavailableReason } from '@/lib/api/git-path-diff';
import { SubmoduleDiffSummary } from './SubmoduleDiffSummary';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { statusToGitCode, type TurnSnapshotDiff } from './turnSnapshotDiff';
import { toast } from '@/components/ui';

import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { getLanguageFromExtension, isImageFile } from '@/lib/toolHelpers';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { DiffViewToggle } from '@/components/chat/message/DiffViewToggle';
import type { DiffViewMode } from '@/components/chat/message/types';
import { ReviewFlowDialog } from '@/components/session/ReviewFlowDialog';
import { useReviewFlowStart } from '@/components/session/useReviewFlowStart';
import { PierreDiffViewer, type ContextExpansionRequest, type DiffFindWordRequest, type DiffHunkActions, type PierreDiffViewerHandle } from './PierreDiffViewer';
import { HunkActions, type HunkBusyState, type HunkDiffAction } from './git/HunkActions';
import { describeChange } from './git/changeStatus';
import {
    FileTreeChevron,
    FileTreeIndentGuides,
    FileTreeStatusLetter,
} from './files/FileTreeRowParts';
import {
    fileTreeRowPaddingLeft,
    fileTreeRowStateClassName,
} from './files/fileTreeRow';
import { useDeviceInfo } from '@/lib/device';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from "@/components/icon/Icon";
import { ToolbarButton, ToolbarTooltipButton } from '@/components/ui/action-toolbar';
import { toastContextFileOpenFailure, validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { StatusImage } from '@/components/ui/status-image';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import { sessionEvents } from '@/lib/sessionEvents';
import { findDiffScrollAnchor, getRestoredDiffScrollTop, type DiffScrollAnchor } from './diffScrollAnchor';
import { isRightToLeft, useI18n } from '@/lib/i18n';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { useChangeRequestTerm } from '@/lib/source-control/providers/registry';
import { buildDiffTreeRows } from './diffFileTree';
import { fileDiffFromPatch, isBinaryPatch, extractHunkPatch, haveMatchingPatchVersions, getPatchHunkAnchors } from '@/lib/diff/patchFileDiff';
import { isVSCodeRuntime } from '@/lib/desktop';
import { WALKTHROUGH_ACTION_CLASS } from '@/components/views/walkthrough/walkthroughAction';
import type { WalkthroughTarget } from '@/lib/walkthrough/types';
import { useWalkthroughStore } from '@/stores/useWalkthroughStore';
import { usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionMessages } from '@/sync/sync-context';
import { opencodeClient } from '@/lib/opencode/client';
import { getFirstChangedModifiedLineFromPatch } from './diffPatchUtils';
import { parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import type { DiffFindMatch } from '@/lib/diff/diffFind';
import { DiffFindBar } from './diffFind/DiffFindBar';
import { resolveFindDiff, useDiffFind, type DiffFindLayout, type DiffFindNestedSources, type DiffFindSource } from './diffFind/useDiffFind';
import { useDiffFindSurface } from './diffFind/useDiffFindSurface';
import { createFindDiffBatchReader } from './diffFind/findDiffBatch';
import { diffCommentOriginFromSource, type DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { useWholeFileComment, WholeFileCommentButton } from '@/components/comments';

// Minimum width for side-by-side diff view (px)
const SIDE_BY_SIDE_MIN_WIDTH = 1100;
const DIFF_REQUEST_TIMEOUT_MS = 15000;
const LARGE_DIFF_CHANGED_LINES = 500;
const STACKED_DIFF_MOUNT_MARGIN = 300;
const FULL_CONTEXT_DIFF_LINES = 1_000_000;
const DEFAULT_CONTEXT_DIFF_LINES = 3;

// Perf: limit concurrent expanded diffs in stacked view.
// Expanding many diffs mounts many Pierre instances + lots of DOM.
const getStackedViewDefaultExpandedCount = (fileCount: number): number => {
    if (fileCount <= 6) return fileCount;
    if (fileCount <= 12) return 6;
    if (fileCount <= 25) return 4;
    return 2;
};

type FileEntry = GitStatus['files'][number] & {
    insertions: number;
    deletions: number;
    isNew: boolean;
};

type DiffContextMode = 'patch' | 'full';
type DiffData = {
    original: string;
    modified: string;
    isBinary?: boolean;
    patch?: string;
    fileDiff?: FileDiffMetadata;
    contextMode?: DiffContextMode;
    /** Set for a live working or staged diff of a submodule; its patch alone can be empty. */
    submodule?: GitSubmoduleState | null;
};
/** An unavailable path is a stale or non-file status row, not a failed request. */
type DiffLoadFailure =
    | { kind: 'error'; message: string }
    | { kind: 'unavailable'; reason: GitPathUnavailableReason };
type DiffScope = 'all' | PendingDiffScope;


type ComparisonDiffResult =
    | { status: 'loading' }
    | { status: 'ready'; data: DiffData }
    | { status: 'error'; message: string };
const EMPTY_COMPARISON_DIFF: ComparisonDiffResult = { status: 'loading' };

/** Bounded retries for branch metadata in the context diff panel (see effect). */
const BRANCH_METADATA_MAX_ATTEMPTS = 3;


const BinaryDiffPlaceholder = React.memo(() => {
    const { t } = useI18n();
    return (
        <div className="rounded-lg border border-edge bg-background px-3 py-2">
            <div className="typography-meta text-muted-foreground">{t('diffView.binary.unavailable')}</div>
        </div>
    );
});

const isNewStatusFile = (file: GitStatus['files'][number]): boolean => {
    const { index, working_dir: workingDir } = file;
    return index === 'A' || workingDir === 'A' || index === '?' || workingDir === '?';
};

const isStagedStatusFile = (file: GitStatus['files'][number]): boolean => {
    const indexCode = file.index?.trim();
    return Boolean(indexCode && indexCode !== '?');
};

const isWorkingStatusFile = (file: GitStatus['files'][number]): boolean => {
    const workingCode = file.working_dir?.trim();
    return Boolean(workingCode) || file.index === '?';
};

const toAbsolutePath = (directory: string, filePath: string): string => {
    return toAbsoluteFilePath(directory, filePath);
};

const getFirstChangedModifiedLine = (original: string, modified: string): number => {
    const originalLines = original.split('\n');
    const modifiedLines = modified.split('\n');
    const sharedLength = Math.min(originalLines.length, modifiedLines.length);

    for (let index = 0; index < sharedLength; index += 1) {
        if (originalLines[index] !== modifiedLines[index]) {
            return index + 1;
        }
    }

    if (modifiedLines.length > originalLines.length) {
        return originalLines.length + 1;
    }

    if (originalLines.length > modifiedLines.length) {
        return Math.max(1, modifiedLines.length);
    }

    return 1;
};

const createTextDiffDataFromPatch = (filePath: string, patch: string, contextMode: DiffContextMode): DiffData => {
    if (isBinaryPatch(patch)) {
        return { original: '', modified: '', isBinary: true, patch, contextMode };
    }

    return {
        original: '',
        modified: '',
        patch,
        fileDiff: fileDiffFromPatch(filePath, patch),
        contextMode,
    };
};

/**
 * Searchable metadata for a file from either a patch-backed diff (its
 * `fileDiff` is already parsed) or a turn payload's full contents (parsed here).
 * Binary and submodule entries have no lines to search and resolve to null.
 */
const diffDataToFileDiff = (
    filePath: string,
    data: { original: string; modified: string; isBinary?: boolean; submodule?: GitSubmoduleState | null; fileDiff?: FileDiffMetadata },
): FileDiffMetadata | null => {
    // A submodule entry renders as a summary, not as lines, whatever it parsed to.
    if (data.isBinary || data.submodule) return null;
    if (data.fileDiff) return data.fileDiff;
    if (!data.original && !data.modified) return null;
    return parseDiffFromFile({ name: filePath, contents: data.original }, { name: filePath, contents: data.modified });
};

// Identity of a diff payload for find revisions: a new read hands back a new
// object, so its id moves while an unchanged payload keeps its own.
const findPayloadIds = new WeakMap<ComparisonDiffResult | DiffData, number>();
let nextFindPayloadId = 0;
const findPayloadRevision = (payload: ComparisonDiffResult | DiffData | undefined): string => {
    if (!payload) return 'absent';
    let id = findPayloadIds.get(payload);
    if (id === undefined) {
        nextFindPayloadId += 1;
        id = nextFindPayloadId;
        findPayloadIds.set(payload, id);
    }
    return String(id);
};

/** A find jump into a file: its entry renders it even past the large-diff gate. */
interface DiffFindReveal {
    /** The match's source key: a file path, or a nested repository row plus the nested path. */
    key: string;
    nonce: number;
}

/** Whether the entry for `rowPath` holds the find source `key`. */
const isFindRevealFor = (rowPath: string, key: string): boolean =>
    key === rowPath || (rowPath.endsWith('/') && key.startsWith(rowPath));

const formatDiffTotals = (
    insertions?: number,
    deletions?: number,
    options?: { shrink?: boolean; className?: string },
) => {
    const added = insertions ?? 0;
    const removed = deletions ?? 0;
    if (!added && !removed) return null;
    return (
        <span
            className={cn(
                'typography-meta flex items-center gap-1 text-xs whitespace-nowrap',
                options?.shrink ? 'min-w-0 overflow-hidden' : 'flex-shrink-0',
                options?.className,
            )}
        >
            {added ? <span style={{ color: 'var(--status-success)' }}>+{added}</span> : null}
            {removed ? <span style={{ color: 'var(--status-error)' }}>-{removed}</span> : null}
        </span>
    );
};

interface FileListProps {
    changedFiles: FileEntry[];
    selectedFile: string | null;
    onSelectFile: (path: string) => void;
}

const FileList = React.memo<FileListProps>(({
    changedFiles,
    selectedFile,
    onSelectFile,
}) => {
    const { t } = useI18n();
    if (changedFiles.length === 0) return null;

    return (
        <ScrollableOverlay outerClassName="flex-1 min-h-0" className="px-2 py-2">
            <ul className="flex flex-col gap-1">
                {changedFiles.map((file) => {
                    const descriptor = describeChange(file);
                    const isActive = selectedFile === file.path;

                    return (
                        <li key={file.path}>
                            <button
                                type="button"
                                onClick={() => onSelectFile(file.path)}
                                className={cn(
                                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start transition-colors',
                                    isActive
                                        ? 'bg-interactive-selection text-interactive-selection-foreground'
                                        : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
                                )}
                            >
                                <FileTypeIcon filePath={file.path} className="h-3.5 w-3.5 flex-shrink-0" />
                                <span
                                    className="typography-micro font-semibold w-4 text-center uppercase"
                                    style={{ color: descriptor.color }}
                                    title={t(descriptor.descriptionKey)}
                                    aria-label={t(descriptor.descriptionKey)}
                                >
                                    {descriptor.code}
                                </span>
                                <span
                                    className="oc-ui-start-align min-w-0 flex-1 truncate typography-meta"
                                    style={{ direction: 'rtl', unicodeBidi: 'plaintext' }}
                                    title={file.path}
                                >
                                    {file.path}
                                </span>
                                {formatDiffTotals(file.insertions, file.deletions)}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </ScrollableOverlay>
    );
});

const FILE_TREE_MIN_WIDTH = 160;
const FILE_TREE_MAX_FRACTION = 0.5;

const FileTree = React.memo<FileListProps>(({
    changedFiles,
    selectedFile,
    onSelectFile,
}) => {
    const { t } = useI18n();
    const [collapsedDirectories, setCollapsedDirectories] = React.useState<ReadonlySet<string>>(() => new Set());
    const rows = React.useMemo(
        () => buildDiffTreeRows(changedFiles, collapsedDirectories),
        [changedFiles, collapsedDirectories],
    );

    // Keyboard navigation can land on a file inside a collapsed directory.
    React.useEffect(() => {
        if (!selectedFile) return;
        setCollapsedDirectories((previous) => {
            const hiding = Array.from(previous).filter((path) => selectedFile.startsWith(`${path}/`));
            if (hiding.length === 0) return previous;
            const next = new Set(previous);
            hiding.forEach((path) => next.delete(path));
            return next;
        });
    }, [selectedFile]);

    const toggleDirectory = React.useCallback((path: string) => {
        setCollapsedDirectories((previous) => {
            const next = new Set(previous);
            if (!next.delete(path)) {
                next.add(path);
            }
            return next;
        });
    }, []);

    return (
        <ScrollableOverlay outerClassName="flex-1 min-h-0" className="px-1.5 py-1.5">
            <ul className="flex flex-col">
                {rows.map((row) => {
                    const paddingLeft = fileTreeRowPaddingLeft(row.depth);

                    if (row.kind === 'directory') {
                        return (
                            <li key={row.key} className="relative">
                                <FileTreeIndentGuides depth={row.depth} />
                                <button
                                    type="button"
                                    onClick={() => toggleDirectory(row.path)}
                                    aria-expanded={row.expanded}
                                    aria-label={row.expanded
                                        ? t('diffView.fileTree.collapseDirectoryAria', { path: row.path })
                                        : t('diffView.fileTree.expandDirectoryAria', { path: row.path })}
                                    className="flex w-full items-center gap-1 rounded-md py-1 pe-2 text-start text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
                                    style={{ paddingInlineStart: paddingLeft }}
                                    title={row.path}
                                >
                                    <FileTreeChevron expanded={row.expanded} />
                                    <span className="min-w-0 flex-1 truncate typography-meta">{row.label}</span>
                                </button>
                            </li>
                        );
                    }

                    const descriptor = describeChange(row.file);
                    const isActive = selectedFile === row.file.path;
                    return (
                        <li key={row.key} className="relative">
                            <FileTreeIndentGuides depth={row.depth} />
                            <button
                                type="button"
                                onClick={() => onSelectFile(row.file.path)}
                                aria-current={isActive ? 'true' : undefined}
                                className={cn(
                                    'flex w-full items-center gap-1.5 rounded-md py-1 pe-2 text-start transition-colors',
                                    fileTreeRowStateClassName(isActive)
                                )}
                                style={{ paddingInlineStart: paddingLeft }}
                                title={row.file.path}
                            >
                                <FileTypeIcon filePath={row.file.path} className="ms-0.5 size-3.5 flex-shrink-0" />
                                <span className="min-w-0 flex-1 truncate typography-meta">{row.name}</span>
                                <FileTreeStatusLetter
                                    code={descriptor.code}
                                    color={descriptor.color}
                                    label={t(descriptor.descriptionKey)}
                                />
                            </button>
                        </li>
                    );
                })}
            </ul>
        </ScrollableOverlay>
    );
});

// Image diff viewer for binary image files
interface InlineImageDiffViewerProps {
    filePath: string;
    diff: DiffData;
    renderSideBySide: boolean;
}

const InlineImageDiffViewer = React.memo<InlineImageDiffViewerProps>(({
    filePath,
    diff,
    renderSideBySide,
}) => {
    const { t } = useI18n();
    const hasOriginal = diff.original.length > 0;
    const hasModified = diff.modified.length > 0;

    const containerClass = renderSideBySide
        ? 'flex flex-row gap-6 items-start justify-center'
        : 'flex flex-col gap-4 items-center';

    const imageContainerClass = renderSideBySide
        ? 'flex flex-col items-center gap-2 flex-1 min-w-0'
        : 'flex flex-col items-center gap-2';

    return (
        <div className="w-full overflow-auto p-4" style={{ contain: 'layout' }}>
            <div className={containerClass}>
                {hasOriginal && (
                    <div className={imageContainerClass}>
                        <span className="typography-meta text-muted-foreground font-medium">{t('diffView.image.original')}</span>
                        <StatusImage
                            src={diff.original}
                            alt={t('diffView.image.originalAlt', { path: filePath })}
                            variant="large"
                            // Room for the loading and failed states before the image has a size.
                            className="flex min-h-40 min-w-40 max-w-full items-center justify-center"
                            imgClassName={renderSideBySide ? "max-w-full max-h-[70vh] object-contain" : "max-w-full object-contain"}
                            imgStyle={{ imageRendering: 'auto' }}
                        />
                    </div>
                )}
                {hasModified && (
                    <div className={imageContainerClass}>
                        <span className="typography-meta text-muted-foreground font-medium">
                            {hasOriginal ? t('diffView.image.modified') : t('diffView.image.new')}
                        </span>
                        <StatusImage
                            src={diff.modified}
                            alt={t('diffView.image.modifiedAlt', { path: filePath })}
                            variant="large"
                            // Room for the loading and failed states before the image has a size.
                            className="flex min-h-40 min-w-40 max-w-full items-center justify-center"
                            imgClassName={renderSideBySide ? "max-w-full max-h-[70vh] object-contain" : "max-w-full object-contain"}
                            imgStyle={{ imageRendering: 'auto' }}
                        />
                    </div>
                )}
            </div>
        </div>
    );
});

interface InlineDiffViewerProps {
  filePath: string;
  diff: DiffData;
  /** The diff this is, for comments; absent for uncommitted changes. */
  commentOrigin?: DiffCommentOrigin;
  staged: boolean;
  renderSideBySide: boolean;
  wrapLines: boolean;
  hideWhitespace: boolean;
  hunkActions?: DiffHunkActions;
  onExpandContextRequest?: (request: ContextExpansionRequest) => void;
  pendingContextExpansion?: ContextExpansionRequest | null;
  contextLoading?: boolean;
  /** Find-in-diff handle for this file's rendered diff. */
  viewerRef?: React.Ref<PierreDiffViewerHandle>;
  /** Reports a primary-modifier word click so the owner can open find on it. */
  onFindWordRequest?: (request: DiffFindWordRequest) => void;
}

const InlineDiffViewer = React.memo<InlineDiffViewerProps>(({
  filePath,
  diff,
  commentOrigin,
  staged,
  renderSideBySide,
  wrapLines,
  hideWhitespace,
  hunkActions,
  onExpandContextRequest,
  pendingContextExpansion,
  contextLoading,
  viewerRef,
  onFindWordRequest,
}) => {
  const language = React.useMemo(
    () => getLanguageFromExtension(filePath) || 'text',
    [filePath]
  );

  if (diff.submodule) {
    return <SubmoduleDiffSummary state={diff.submodule} staged={staged} />;
  }

  if (diff.isBinary) {
    return <BinaryDiffPlaceholder />;
  }

  if (isImageFile(filePath)) {
    return (
            <InlineImageDiffViewer
                filePath={filePath}
                diff={diff}
                renderSideBySide={renderSideBySide}
            />
    );
  }

  return (
    <div className="w-full" style={{ contain: 'layout' }}>
      <PierreDiffViewer
        ref={viewerRef}
        original={diff.original}
        modified={diff.modified}
        fileDiff={diff.fileDiff}
        language={language}
        fileName={filePath}
        commentOrigin={commentOrigin}
        renderSideBySide={renderSideBySide}
        wrapLines={wrapLines}
        hideWhitespace={hideWhitespace}
        layout="inline"
        hunkActions={hunkActions}
        onExpandContextRequest={onExpandContextRequest}
        pendingContextExpansion={pendingContextExpansion}
        contextLoading={contextLoading}
        onFindWordRequest={onFindWordRequest}
      />
    </div>
  );
});

const toNestedFileEntries = (status: GitStatus): FileEntry[] => status.files
    .map((file) => {
        const staged = status.diffStats?.staged?.[file.path];
        const working = status.diffStats?.working?.[file.path];
        return {
            ...file,
            insertions: (staged?.insertions ?? 0) + (working?.insertions ?? 0),
            deletions: (staged?.deletions ?? 0) + (working?.deletions ?? 0),
            isNew: isNewStatusFile(file),
        };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

interface NestedRepositoryDiffProps {
    renderSideBySide: boolean;
    wrapLines: boolean;
    hideWhitespace: boolean;
    /**
     * Find-in-diff: the parent row's `dir/` path. A nested file's find key is
     * this prefix plus its path inside the nested repository.
     */
    findKeyPrefix?: string;
    registerViewerRef?: (key: string, handle: PierreDiffViewerHandle | null) => void;
    onFindWordRequest?: (key: string, request: DiffFindWordRequest) => void;
    /** A find jump into one of this repository's files. */
    findReveal?: DiffFindReveal | null;
}

interface NestedRepositoryFileDiffProps extends NestedRepositoryDiffProps {
    directory: string;
    file: FileEntry;
    revision: number;
}

/** One file of a nested repository, read-only. */
const NestedRepositoryFileDiff = React.memo<NestedRepositoryFileDiffProps>(({
    directory,
    file,
    revision,
    renderSideBySide,
    wrapLines,
    hideWhitespace,
    findKeyPrefix,
    registerViewerRef,
    onFindWordRequest,
    findReveal = null,
}) => {
    const { t } = useI18n();
    const { git } = useRuntimeAPIs();
    const [result, setResult] = React.useState<ComparisonDiffResult>(EMPTY_COMPARISON_DIFF);
    const [forceRenderLarge, setForceRenderLarge] = React.useState(false);
    const findKey = findKeyPrefix === undefined ? null : `${findKeyPrefix}${file.path}`;
    React.useEffect(() => {
        if (findKey !== null && findReveal?.key === findKey) setForceRenderLarge(true);
    }, [findKey, findReveal]);
    const setViewerRef = React.useCallback((handle: PierreDiffViewerHandle | null) => {
        if (findKey !== null) registerViewerRef?.(findKey, handle);
    }, [findKey, registerViewerRef]);
    const handleFindWordRequest = React.useCallback((request: DiffFindWordRequest) => {
        if (findKey !== null) onFindWordRequest?.(findKey, request);
    }, [findKey, onFindWordRequest]);
    // A file changed only in the index has an empty working diff.
    const staged = isStagedStatusFile(file) && !isWorkingStatusFile(file);
    const fileStatusKey = `${file.index}:${file.working_dir}:${file.insertions}:${file.deletions}`;

    React.useEffect(() => {
        let cancelled = false;
        const runtimeKey = getRuntimeKey();
        const request: Promise<DiffData> = isImageFile(file.path)
            ? git.getGitFileDiff(directory, { path: file.path, staged }).then((response) => ({
                original: response.original ?? '',
                modified: response.modified ?? '',
                isBinary: response.isBinary,
                submodule: response.submodule,
                contextMode: 'full',
            }))
            : git.getGitDiff(directory, { path: file.path, staged, contextLines: DEFAULT_CONTEXT_DIFF_LINES }).then((response) => ({
                ...createTextDiffDataFromPatch(file.path, response.diff, 'patch'),
                submodule: response.submodule,
            }));
        // A refetch keeps the diff on screen until its replacement arrives.
        void request.then(
            (data) => {
                if (cancelled || runtimeKey !== getRuntimeKey()) return;
                setResult({ status: 'ready', data });
            },
            (error) => {
                if (cancelled || runtimeKey !== getRuntimeKey()) return;
                const message = error instanceof GitPathUnavailableError
                    ? error.reason === 'nested_repository'
                        ? t('diffView.unavailable.nestedRepositoryTitle')
                        : error.reason === 'untracked_directory'
                            ? t('diffView.unavailable.untrackedDirectoryTitle')
                            : t('diffView.unavailable.missingTitle')
                    : error instanceof Error ? error.message : String(error);
                setResult({ status: 'error', message });
            },
        );
        return () => {
            cancelled = true;
        };
    }, [directory, file.path, fileStatusKey, git, revision, staged, t]);

    if (result.status === 'loading') {
        return (
            <div className="flex items-center justify-center gap-2 px-4 py-4 typography-meta text-muted-foreground">
                <Icon name="loader-4" className="size-4 animate-spin" />
                {t('diffView.state.loadingDiff')}
            </div>
        );
    }
    if (result.status === 'error') {
        return <div className="px-4 py-4 text-center typography-meta text-muted-foreground">{result.message}</div>;
    }
    if (!forceRenderLarge && file.insertions + file.deletions > LARGE_DIFF_CHANGED_LINES) {
        return (
            <div className="flex flex-col items-center gap-2 px-4 py-4 typography-meta text-muted-foreground">
                {t('diffView.state.largeDiff', { count: file.insertions + file.deletions })}
                <button
                    type="button"
                    className="typography-ui-label text-primary hover:underline"
                    onClick={() => setForceRenderLarge(true)}
                >
                    {t('diffView.actions.renderAnyway')}
                </button>
            </div>
        );
    }
    return (
        <InlineDiffViewer
            filePath={file.path}
            diff={result.data}
            staged={staged}
            renderSideBySide={renderSideBySide}
            wrapLines={wrapLines}
            hideWhitespace={hideWhitespace}
            viewerRef={setViewerRef}
            onFindWordRequest={handleFindWordRequest}
        />
    );
});

type NestedRepositoryStatus =
    | { kind: 'loading' }
    | { kind: 'ready'; files: FileEntry[] }
    | { kind: 'error'; message: string };

interface NestedRepositoryChangesProps extends NestedRepositoryDiffProps {
    /** Absolute path of the nested repository. */
    directory: string;
    /** Bumped when the parent's working tree may have changed; the listing reads again. */
    revision: number;
}

/**
 * Body of a status row that is a Git repository of its own inside the
 * project. The parent's status lists it as one `dir/` row, so its changes are
 * read from the nested repository: the changed files, each diff opened on
 * demand, read-only. Committing happens with that repository open as a project.
 */
const NestedRepositoryChanges = React.memo<NestedRepositoryChangesProps>(({
    directory,
    revision,
    renderSideBySide,
    wrapLines,
    hideWhitespace,
    findKeyPrefix,
    registerViewerRef,
    onFindWordRequest,
    findReveal = null,
}) => {
    const { t } = useI18n();
    const { git } = useRuntimeAPIs();
    const addProject = useProjectsStore((state) => state.addProject);
    const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
    const [status, setStatus] = React.useState<NestedRepositoryStatus>({ kind: 'loading' });
    const [retryNonce, setRetryNonce] = React.useState(0);
    const [expandedFiles, setExpandedFiles] = React.useState<ReadonlySet<string>>(() => new Set());

    React.useEffect(() => {
        let cancelled = false;
        const runtimeKey = getRuntimeKey();
        // A refetch keeps the listing on screen until its replacement arrives.
        void git.getGitStatus(directory, { fresh: true }).then(
            (next) => {
                if (cancelled || runtimeKey !== getRuntimeKey()) return;
                setStatus({ kind: 'ready', files: toNestedFileEntries(next) });
            },
            (error) => {
                if (cancelled || runtimeKey !== getRuntimeKey()) return;
                setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
            },
        );
        return () => {
            cancelled = true;
        };
    }, [directory, git, revision, retryNonce]);

    // A find jump into one of this repository's files opens that file.
    React.useEffect(() => {
        if (!findReveal || findKeyPrefix === undefined || !findReveal.key.startsWith(findKeyPrefix)) return;
        const nestedPath = findReveal.key.slice(findKeyPrefix.length);
        setExpandedFiles((previous) => (previous.has(nestedPath) ? previous : new Set(previous).add(nestedPath)));
    }, [findKeyPrefix, findReveal]);

    const toggleFile = React.useCallback((path: string) => {
        setExpandedFiles((previous) => {
            const next = new Set(previous);
            if (!next.delete(path)) next.add(path);
            return next;
        });
    }, []);

    const openAsProject = React.useCallback(async () => {
        const project = await addProject(directory);
        if (!project) {
            toast.error(t('diffView.nestedRepository.openFailed'));
            return;
        }
        openNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.path });
    }, [addProject, directory, openNewSessionDraft, t]);

    return (
        <div className="flex flex-col gap-2 py-3">
            <div className="flex items-center gap-3 px-3">
                <div className="min-w-0 flex-1">
                    <div className="typography-ui-label font-semibold text-foreground">
                        {t('diffView.unavailable.nestedRepositoryTitle')}
                    </div>
                    <div className="typography-meta text-muted-foreground">
                        {t('diffView.nestedRepository.description')}
                    </div>
                </div>
                <Button variant="outline" size="sm" className="shrink-0" onClick={() => void openAsProject()}>
                    {t('diffView.nestedRepository.openAsProject')}
                </Button>
            </div>
            {status.kind === 'loading' ? (
                <div className="flex items-center justify-center gap-2 px-4 py-4 typography-meta text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />
                    {t('diffView.nestedRepository.loading')}
                </div>
            ) : null}
            {status.kind === 'error' ? (
                <div className="flex flex-col items-center gap-2 px-4 py-4">
                    <div className="typography-ui-label font-semibold text-foreground">
                        {t('diffView.nestedRepository.loadFailed')}
                    </div>
                    <div className="typography-meta text-muted-foreground max-w-[32rem] text-center">{status.message}</div>
                    <button
                        type="button"
                        className="typography-ui-label text-primary hover:underline"
                        onClick={() => setRetryNonce((nonce) => nonce + 1)}
                    >
                        {t('diffView.actions.retry')}
                    </button>
                </div>
            ) : null}
            {status.kind === 'ready' && status.files.length === 0 ? (
                <div className="px-3 typography-meta text-muted-foreground">{t('diffView.nestedRepository.noChanges')}</div>
            ) : null}
            {status.kind === 'ready' && status.files.length > 0 ? (
                <ul className="flex flex-col">
                    {status.files.map((nestedFile) => {
                        const isOpen = expandedFiles.has(nestedFile.path);
                        const descriptor = describeChange(nestedFile);
                        return (
                            <li key={nestedFile.path}>
                                <button
                                    type="button"
                                    aria-expanded={isOpen}
                                    onClick={() => toggleFile(nestedFile.path)}
                                    className="flex w-full items-center gap-2 px-3 py-1 text-start text-foreground/80 transition-colors hover:text-foreground"
                                    title={nestedFile.path}
                                >
                                    <Icon name={isOpen ? 'arrow-down-s' : 'arrow-right-s'} className="size-4 shrink-0 text-muted-foreground" />
                                    <span
                                        className="typography-micro font-semibold w-4 shrink-0 text-center uppercase"
                                        style={{ color: descriptor.color }}
                                        title={t(descriptor.descriptionKey)}
                                        aria-label={t(descriptor.descriptionKey)}
                                    >
                                        {descriptor.code}
                                    </span>
                                    <FileTypeIcon filePath={nestedFile.path} className="size-3.5 shrink-0" />
                                    <span
                                        className="oc-ui-start-align min-w-0 flex-1 truncate typography-meta"
                                        style={{ direction: 'rtl', unicodeBidi: 'plaintext' }}
                                    >
                                        {nestedFile.path}
                                    </span>
                                    {formatDiffTotals(nestedFile.insertions, nestedFile.deletions)}
                                </button>
                                {isOpen ? (
                                    <NestedRepositoryFileDiff
                                        directory={directory}
                                        file={nestedFile}
                                        revision={revision}
                                        renderSideBySide={renderSideBySide}
                                        wrapLines={wrapLines}
                                        hideWhitespace={hideWhitespace}
                                        findKeyPrefix={findKeyPrefix}
                                        registerViewerRef={registerViewerRef}
                                        onFindWordRequest={onFindWordRequest}
                                        findReveal={findReveal?.key === `${findKeyPrefix}${nestedFile.path}` ? findReveal : null}
                                    />
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            ) : null}
        </div>
    );
});

interface MultiFileDiffEntryProps {
    visible?: boolean;
    directory: string;
    file: FileEntry;
    layout: 'inline' | 'side-by-side';
    wrapLines: boolean;
    /** Show lines that changed only by whitespace as unchanged, without hunk actions. */
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
    /**
     * Start with full file contents instead of the 3-line patch. Off in the
     * app: a file loads in full when the user expands its collapsed context.
     */
    loadFullFiles?: boolean;
    initialDiffData?: DiffData | null;
    comparisonDiff?: ComparisonDiffResult;
    /** The comparison `comparisonDiff` comes from, for comments. */
    commentOrigin?: DiffCommentOrigin;
    onRetryComparisonDiff?: () => void;
    /** Full-context variant of `comparisonDiff` for this file, fetched when the user expands collapsed context. */
    loadFullComparisonDiff?: (filePath: string) => Promise<ComparisonDiffResult>;
    /** Hide stage/unstage/revert actions for branch and commit comparisons. */
    readOnlyActions?: boolean;
    /** Hunk mutations require a live working/index diff, never a turn snapshot. */
    hunkActionsEnabled?: boolean;
    /**
     * Bumped when the working tree may have changed without the status row
     * changing: an edit inside an already-modified line keeps `+1/-1`. A live
     * diff older than this revision is refetched in place, behind the data it
     * still shows.
     */
    contentRevision?: number;
    /** Find-in-diff: register this file's rendered viewer handle. */
    registerViewerRef?: (path: string, handle: PierreDiffViewerHandle | null) => void;
    /** Reports a primary-modifier word click on `path` so the owner can open find on it. */
    onFindWordRequest?: (path: string, request: DiffFindWordRequest) => void;
    /** Reports whether this entry shows the whole file, so find reads it the same way. */
    onFullContextChange?: (path: string, full: boolean) => void;
    /** A find jump into this entry; null when the active match is elsewhere. */
    findReveal?: DiffFindReveal | null;
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
}) => {
    const { t } = useI18n();
    const { git } = useRuntimeAPIs();
    const wholeFileComment = useWholeFileComment({ fileLabel: file.path, origin: rangeComparisonDiff ? commentOrigin : undefined });
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
    // Range diffs (branch/commit) are cached per range with 3-line context;
    // the full-context copy for this one file lives here until the range entry changes.
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
    // Set when the user expands collapsed context on the patch-only diff:
    // this file alone switches to full contents, then replays the expansion.
    const [contextExpansion, setContextExpansion] = React.useState<ContextExpansionRequest | null>(null);
    const loadFullFiles = loadAllFullFiles || contextExpansion !== null;
    React.useEffect(() => {
        if (!loadFullFiles || !onFullContextChange) return;
        onFullContextChange(file.path, true);
        return () => onFullContextChange(file.path, false);
    }, [file.path, loadFullFiles, onFullContextChange]);
    // A find jump into this file shows it even when it is over the large-diff
    // limit: the match the bar points at has to be on screen.
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
    const fileStatusKey = `${file.index}:${file.working_dir}:${file.insertions}:${file.deletions}`;
    const hunkEligible = hunkActionsEnabled && !readOnlyActions && !initialDiffData && !comparisonDiff && !isImageFile(file.path);
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

    const setSectionRef = React.useCallback((node: HTMLDivElement | null) => {
        sectionRef.current = node;
        registerSectionRef(file.path, node);
    }, [file.path, registerSectionRef]);

    const setViewerRef = React.useCallback((handle: PierreDiffViewerHandle | null) => {
        registerViewerRef?.(file.path, handle);
    }, [file.path, registerViewerRef]);

    // Stable per file, so the memoized viewer is not re-rendered by a new
    // closure on every parent render; `onFindWordRequest` itself is stable.
    const handleFindWordRequest = React.useCallback((request: DiffFindWordRequest) => {
        onFindWordRequest?.(file.path, request);
    }, [file.path, onFindWordRequest]);

    const handleOpenChange = React.useCallback((open: boolean) => {
        onExpandedChange(file.path, open);
    }, [file.path, onExpandedChange]);

    const handleSelect = React.useCallback(() => {
        onSelect(file.path);
    }, [file.path, onSelect]);

    // Switching between the staged and unstaged side shows a different diff,
    // so the side being switched to must not show what it held before. Reset
    // while hidden or collapsed too: the entry loads again only once shown.
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

    // Version the displayed live diff was fetched for: the content revision
    // and the file's status row, which moves with every edit. An older diff
    // stays on screen while its replacement loads instead of collapsing to a
    // spinner, so an agent editing the file does not make it flicker.
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
        const displayRequest = isImageFile(file.path)
            ? git.getGitFileDiff(directory, { path: file.path, staged })
            : !loadFullFiles && actionPatch !== null
                ? Promise.resolve({ diff: actionPatch, submodule: actionSubmodule })
            : git.getGitDiff(directory, { path: file.path, staged, contextLines });
        const canonicalRequest = hunkEligible && loadFullFiles && actionPatch === null
            ? git.getGitDiff(directory, { path: file.path, staged, contextLines: DEFAULT_CONTEXT_DIFF_LINES }).then((response) => response.diff)
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
                        // Also held locally: a refresh clears the shared cache
                        // and the entry keeps showing this until it refetches.
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
                    // The row came from a status listing that is now stale. A
                    // cached or joined status read would return the same list.
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
    }, [actionPatch, actionSubmodule, contentRevision, diffVersion, hunkEligible, isDiffCurrent, patchScope, comparisonDiff, desiredContextMode, diffData, diffDataMatchesContextMode, diffRetryNonce, directory, fetchStatus, file.path, fileStatusKey, git, initialDiffData, isExpanded, isMounted, loadFullFiles, localDiffLoadFailure, setDiff, staged, t, visible]);

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
        // Discard sits next to stage, so one stray click must not lose work.
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
    const renderHunkActions = React.useCallback((index: number) => (
        <HunkActions index={index} staged={staged} busyHunk={hunkAction}
            disabled={isLoading || Boolean(diffLoadFailure)} onAction={handleHunkAction} />
    ), [diffLoadFailure, handleHunkAction, hunkAction, isLoading, staged]);
    const diffHunkActions = React.useMemo<DiffHunkActions | undefined>(() => hunkAnchors.length > 0
        ? { anchors: hunkAnchors, render: renderHunkActions } : undefined, [hunkAnchors, renderHunkActions]);

    return (
        <div ref={setSectionRef} className="scroll-mt-9 border-b border-[var(--interactive-border)]/40 last:border-b-0">
            <div className="sticky top-0 z-30 border-b border-[var(--interactive-border)]/35 bg-[var(--surface-elevated)]/90 backdrop-blur-md supports-[backdrop-filter]:bg-[var(--surface-elevated)]/80">
                <div
                    role="button"
                    tabIndex={0}
                    onClick={handleToggle}
                    onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            handleToggle();
                        }
                    }}
                    className={cn(
                        'cursor-pointer',
                        'group/header relative grid min-h-9 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 overflow-hidden px-3 py-2',
                        'bg-transparent',
                        'text-muted-foreground hover:text-foreground',
                        isSelected ? 'bg-[var(--interactive-selection)]/35' : null
                    )}
                >
                    <div className="absolute inset-0 pointer-events-none group-hover/header:bg-[var(--interactive-hover)]/50" />
                    <div className="relative flex min-w-0 flex-1 items-center gap-2">
                        <span className="flex size-5 items-center justify-center opacity-70 group-hover/header:opacity-100">
                            {isExpanded ? (
                                <Icon name="arrow-down-s" className="size-4" />
                            ) : (
                                <Icon name="arrow-right-s" className="size-4" />
                            )}
                        </span>
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
                            title={file.path}
                        >
                            <span className="flex min-w-0 items-center gap-2">
                                <FileTypeIcon filePath={file.path} className="h-3.5 w-3.5 flex-shrink-0 align-middle" />
                                {(() => {
                                    const lastSlash = file.path.lastIndexOf('/');
                                    if (lastSlash === -1) {
                                        return (
                                            <span
                                                className="oc-ui-start-align block min-w-0 truncate typography-ui-label text-foreground"
                                                style={{ direction: 'rtl', unicodeBidi: 'plaintext' }}
                                            >
                                                {file.path}
                                            </span>
                                        );
                                    }

                                    const dir = file.path.slice(0, lastSlash);
                                    const name = file.path.slice(lastSlash + 1);

                                    return (
                                        <span dir="ltr" className="flex min-w-0 items-baseline overflow-hidden">
                                            <span
                                                className="oc-ui-start-align min-w-0 truncate typography-ui-label text-muted-foreground"
                                                style={{ direction: 'rtl', unicodeBidi: 'plaintext' }}
                                            >
                                                {dir}
                                            </span>
                                            <span className="flex-shrink-0 typography-ui-label">
                                                <span className="text-muted-foreground">/</span>
                                                <span className="text-foreground">{name}</span>
                                            </span>
                                        </span>
                                    );
                                })()}
                            </span>
                        </span>
                    </div>
                    <div className="relative flex shrink-0 items-center justify-self-end gap-2">
                        {formatDiffTotals(file.insertions, file.deletions)}
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
                    </div>
                </div>
                {wholeFileComment.editor}
            </div>
            {wholeFileComment.cards}
            {isExpanded && (
                // Clip, not hidden: a hidden overflow is a scroll box of its
                // own, and the diff's sticky scrollbar would stick to it
                // instead of to the panel.
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
                    {isMounted && diffData && (forceRenderLarge || (file.insertions + file.deletions) <= LARGE_DIFF_CHANGED_LINES) ? (
                        <>
                            <InlineDiffViewer
                                filePath={file.path}
                                diff={diffData}
                                commentOrigin={rangeComparisonDiff ? commentOrigin : undefined}
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

interface DiffViewProps {
    visible?: boolean;
    hideStackedFileSidebar?: boolean;
    stackedDefaultCollapsedAll?: boolean;
    pinSelectedFileHeaderToTopOnNavigate?: boolean;
    showOpenInEditorAction?: boolean;
    /**
     * Null opens on the default: Branch on a branch that has one, else the
     * working tree. A scope the person picks is reported and passed back.
     */
    diffScope?: DiffScope | null;
    onDiffScopeChange?: (scope: PendingDiffScope) => void;
    targetFilePath?: string | null;
    /** Render diff content flush with the container edges (no outer padding). */
    flushContent?: boolean;
    /**
     * Another project's folder, for a pull request opened from the Tracker:
     * the view then shows that PR only, read through that project, with
     * nothing tied to the session on screen. Null works in the panel's own.
     */
    directory?: string | null;
}

export const DiffView: React.FC<DiffViewProps> = ({
    visible = true,
    hideStackedFileSidebar = false,
    stackedDefaultCollapsedAll = false,
    pinSelectedFileHeaderToTopOnNavigate = false,
    showOpenInEditorAction = false,
    diffScope = 'all',
    onDiffScopeChange,
    targetFilePath = null,
    flushContent = false,
    directory: targetDirectory = null,
}) => {
    const { t } = useI18n();
    const inPanelHeader = useInContextPanelHeader();
    const toolbarRef = React.useRef<HTMLDivElement | null>(null);
    useDiffToolbarFit(toolbarRef);
    // The view options the toolbar moved into "More actions", read when the
    // menu opens: the fit sets them as attributes on the row.
    const [toolbarMenuOptions, setToolbarMenuOptions] = React.useState<ReadonlyArray<keyof typeof DIFF_TOOLBAR_MENU_STEPS>>([]);
    const handleToolbarMenuOpenChange = React.useCallback((open: boolean) => {
        if (!open) return;
        const toolbar = toolbarRef.current;
        setToolbarMenuOptions((['walkthrough', 'tree', 'wrap', 'whitespace', 'layout'] as const).filter(
            (option) => toolbar?.hasAttribute(DIFF_TOOLBAR_MENU_STEPS[option]) ?? false,
        ));
    }, []);
    const { git, files, sourceControl } = useRuntimeAPIs();
    const panelDirectory = useEffectiveDirectory();
    const foreign = Boolean(targetDirectory);
    const rootDirectory = targetDirectory ?? panelDirectory;
    const runtimeKey = useGitStore((state) => state.runtimeKey);
    // Diffs belong to the repository being diffed: the picked one, or the
    // root when nothing is picked.
    const { gitDirectory: nestedGitDirectory, repositoryOptions } = useNestedGitDirectory(rootDirectory ?? null, { enabled: visible, recheckOnOpen: true });
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
    const ensureStatus = useGitStore((state) => state.ensureStatus);
    const selectNestedRepo = useGitStore((state) => state.selectNestedRepo);
    const fetchStatus = useGitStore((state) => state.fetchStatus);
    const fetchBranches = useGitStore((state) => state.fetchBranches);
    const clearDiffCache = useGitStore((state) => state.clearDiffCache);
    const setDiff = useGitStore((state) => state.setDiff);
    const [displayFile, setDisplayFile] = React.useState<string | null>(null);
    const [displayFileStaged, setDisplayFileStaged] = React.useState(false);
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
    const sessionMessages = useSessionMessages(activeDiffScope === 'turn' ? currentSessionId ?? '' : '', rootDirectory ?? undefined);
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

    // v1 read the last turn's diffs off a working-tree snapshot on the user
    // message. v2 computes them on request from the turn's snapshots
    // (`GET /api/session/:id/diff`), merged per file, so a file edited three
    // times in one turn is one diff. Refetched whenever the transcript moves
    // (a turn ending is what changes the answer).
    const [lastTurnDiffs, setLastTurnDiffs] = React.useState<TurnSnapshotDiff[]>([]);
    // A failed read is not "this turn changed nothing": it keeps its own state
    // and a retry, and the last good list stays until a read replaces it.
    const [turnDiffError, setTurnDiffError] = React.useState<string | null>(null);
    const [turnDiffAttempt, retryTurnDiff] = React.useReducer((value: number) => value + 1, 0);
    // Another session's turn is never shown while this one's loads.
    React.useEffect(() => {
        setLastTurnDiffs([]);
        setTurnDiffError(null);
    }, [currentSessionId]);
    const lastMessageId = sessionMessages.length > 0 ? sessionMessages[sessionMessages.length - 1].id : '';
    React.useEffect(() => {
        if (activeDiffScope !== 'turn' || !currentSessionId || !visible) return;
        let cancelled = false;
        void opencodeClient.getSessionTurnDiff(currentSessionId, { directory: rootDirectory ?? undefined })
            .then((files) => {
                if (cancelled) return;
                setLastTurnDiffs(files.map((entry) => ({
                    file: entry.file,
                    patch: entry.patch,
                    status: entry.status,
                    additions: entry.additions,
                    deletions: entry.deletions,
                })));
                setTurnDiffError(null);
            })
            .catch((error) => {
                if (cancelled) return;
                console.warn('[diff-view] turn diff unavailable:', error instanceof Error ? error.message : error);
                setTurnDiffError(error instanceof Error ? error.message : t('diffView.state.failedToLoadDiff'));
            });
        return () => {
            cancelled = true;
        };
    }, [activeDiffScope, currentSessionId, lastMessageId, rootDirectory, t, turnDiffAttempt, visible]);

    const lastTurnDiffData = React.useMemo(() => {
        const map = new Map<string, DiffData>();
        for (const diff of lastTurnDiffs) {
            if (!diff.file) continue;
            if (typeof diff.patch === 'string') {
                map.set(diff.file, createTextDiffDataFromPatch(diff.file, diff.patch, 'patch'));
                continue;
            }
            map.set(diff.file, {
                original: diff.before ?? '',
                modified: diff.after ?? '',
                contextMode: 'full',
            });
        }
        return map;
    }, [lastTurnDiffs]);

    const workingFileCount = React.useMemo(() => {
        if (!status?.files) return 0;
        return status.files.filter(isWorkingStatusFile).length;
    }, [status]);

    const stagedFileCount = React.useMemo(() => {
        if (!status?.files) return 0;
        return status.files.filter(isStagedStatusFile).length;
    }, [status]);

    const turnFileCount = lastTurnDiffs.length;

    // ----- Branch scope (all changes on this branch vs its base) -----
    const currentBranch = status?.current ?? null;
    // A pull request opened from the issues and PRs board.
    const requestedPr = usePullRequestSelectionStore((state) => (effectiveDirectory ? state.diffRequests.get(effectiveDirectory) : undefined));
    const prComparison = usePullRequestComparison(effectiveDirectory ?? null, currentBranch, binding.contexts[0] ?? null, visible && activeDiffScope === 'pr' && !isVSCodeRuntime(), requestedPr);
    // Set only when the server serves the project's provider: change-request diffs exist only for those.
    const pullRequestContext = prComparison.readContext;
    const selectedPr = prComparison.selectedSource;
    const prChangeRequestTerm = useChangeRequestTerm(prComparison.provider);
    // Taken once the branch is known: the selection it landed in is the real one.
    React.useEffect(() => {
        if (!effectiveDirectory || !requestedPr || !status || selectedPr !== requestedPr) return;
        usePullRequestSelectionStore.getState().settleDiffRequest(effectiveDirectory, requestedPr);
    }, [effectiveDirectory, requestedPr, selectedPr, status]);
    const commitComparison = useCommitComparison(effectiveDirectory ?? null, currentBranch, visible && activeDiffScope === 'commit' && !isVSCodeRuntime());
    const selectedCommitHash = commitComparison.selectedCommit?.hash ?? null;
    React.useEffect(() => {
        if ((activeDiffScope === 'commit' || activeDiffScope === 'pr') && isVSCodeRuntime()) {
            setActiveDiffScope('working');
            onDiffScopeChange?.('working');
        }
    }, [activeDiffScope, onDiffScopeChange]);
    const branches = useGitStore((state) => (effectiveDirectory ? state.directories.get(effectiveDirectory)?.branches ?? null : null));
    const isLoadingBranches = useGitStore((state) => (effectiveDirectory ? state.directories.get(effectiveDirectory)?.isLoadingBranches ?? false : false));

    // The Branch scope needs defaultBranches metadata that nothing else loads
    // when only the context diff panel is open (GitView and the composer fetch
    // it, and their absence must not hide the option), so load it here. A
    // failed fetch leaves `branches` null and the loading flag settles back to
    // false; the bounded retry below re-issues it a few times per directory and
    // reports exhaustion so a dead repository neither loops forever nor spins
    // the Branch scope on base resolution.
    const startBranchMetadataFetch = React.useCallback(() => {
        if (effectiveDirectory) {
            void fetchBranches(effectiveDirectory, git);
        }
    }, [effectiveDirectory, fetchBranches, git]);
    const branchMetadataExhausted = useBoundedDirectoryRetry(
        effectiveDirectory ?? null,
        visible && isGitRepo !== false,
        isLoadingBranches,
        Boolean(branches),
        startBranchMetadataFetch,
        BRANCH_METADATA_MAX_ATTEMPTS
    );

    const setBaseOverride = useGitBaseBranchStore((state) => state.setOverride);
    const clearBaseOverride = useGitBaseBranchStore((state) => state.clearOverride);
    const remoteNames = React.useMemo(
        () => new Set(binding.read?.repository.remotes.map((remote) => remote.name) ?? []),
        [binding.read]
    );
    // Chosen, else the open pull request's base, else the reflog, else the
    // default branch, qualified to the bound remote's copy where it has one.
    // Resolved in every scope: whether a base exists decides whether the
    // Branch scope is offered at all. VS Code has no context diff panel.
    const { base: qualifiedBranchBase, source: branchBaseSource, resolved: isBranchBaseResolved, revision: branchRevision } = useBranchComparisonBase(
        effectiveDirectory ?? null,
        currentBranch,
        visible && !isVSCodeRuntime() && isGitRepo !== false,
        { branches, remoteNames, primaryRemote: binding.contexts[0]?.primaryRemote, readContext: binding.contexts[0] ?? null },
    );
    // The base above reads the branch's pull request; ask for it while shown,
    // so a stacked branch checked out here compares against its parent.
    const asksBranchPullRequest = visible && !isVSCodeRuntime() && isGitRepo !== false;
    useBranchPullRequestRequest(asksBranchPullRequest ? effectiveDirectory ?? null : null, asksBranchPullRequest ? currentBranch : null, binding);
    const showBranchOption = !isVSCodeRuntime() && isBranchScopeAvailable(currentBranch, qualifiedBranchBase);
    // On a branch with a base, the default view is the whole branch against
    // it, uncommitted work included: what its pull request will merge. It
    // follows the branch until the person picks a view. While the base is
    // still being found the view stays where it is; the coercion below moves
    // it to Changed once the branch is known to have none.
    React.useEffect(() => {
        if (diffScope === null && showBranchOption) setActiveDiffScope('branch');
    }, [diffScope, showBranchOption]);
    // Coercion acts only on CONFIRMED unavailability: the runtime has no branch
    // scope at all, a settled status has no branch (detached HEAD), every base
    // candidate answered without a base (the default branch, or a repository
    // with nothing to compare against), or metadata retries were exhausted.
    // While status and the base are still loading a persisted branch scope
    // must survive instead of being rewritten to working on the first render.
    // `status !== null` is the settled test: before the first status request
    // even starts, status is null with loading still false, and that must not
    // read as "settled without a branch".
    const isBranchStatusResolved = status !== null;
    const branchScopeDefinitelyUnavailable = isVSCodeRuntime()
        || isGitRepo === false
        || branchMetadataExhausted
        || isBranchScopeDefinitelyUnavailable(
            currentBranch,
            qualifiedBranchBase,
            isBranchStatusResolved,
            isBranchBaseResolved && binding.status === 'ready'
        );
    const [comparisonRetryRevision, setComparisonRetryRevision] = React.useState(0);

    // A context tab persists its scope across branch checkouts and runtime
    // switches. When the Branch scope is CONFIRMED unavailable (checked out the
    // known default branch, VS Code runtime), fall back to Working instead of
    // rendering the base-resolution spinner forever. Persist the coercion so
    // the tab and the selector agree. Note it keys off confirmed
    // unavailability, not off `showBranchOption`: while metadata loads the
    // option is hidden but a persisted branch scope must not be rewritten.
    React.useEffect(() => {
        const coercedScope = coerceDiffScope(activeDiffScope, !branchScopeDefinitelyUnavailable);
        if (coercedScope !== activeDiffScope) {
            setActiveDiffScope(coercedScope);
            // The only coercion is 'branch' -> 'working', so the persisted
            // value always fits the callback domain. A default view is not
            // persisted: it follows the branch on its own.
            if (coercedScope === 'working' && diffScope !== null) {
                onDiffScopeChange?.('working');
            }
        }
    }, [activeDiffScope, branchScopeDefinitelyUnavailable, diffScope, onDiffScopeChange]);

    const comparisonSource = React.useMemo<GitComparisonSource | null>(() => {
        if (activeDiffScope === 'pr') return prComparison.diffUnavailable ? null : selectedPr;
        if (activeDiffScope === 'commit' && selectedCommitHash) return { kind: 'commit', hash: selectedCommitHash };
        if (activeDiffScope === 'branch' && qualifiedBranchBase && currentBranch) {
            return { kind: 'branch', baseRef: qualifiedBranchBase, headRef: currentBranch };
        }
        return null;
    }, [activeDiffScope, qualifiedBranchBase, currentBranch, selectedCommitHash, selectedPr, prComparison.diffUnavailable]);
    const selectedPrHead = selectedPr ? prComparison.prs.find((pr) => pr.number === selectedPr.number)?.headSha : undefined;
    const commentOrigin = React.useMemo(
        () => diffCommentOriginFromSource(comparisonSource, { provider: prComparison.provider, revision: selectedPrHead }),
        [comparisonSource, prComparison.provider, selectedPrHead],
    );
    const comparison = useGitComparison(effectiveDirectory ?? null, comparisonSource, visible && !isVSCodeRuntime(), activeDiffScope === 'branch' ? branchRevision : '', prComparison.readContext, prComparison.provider);
    const { fetchDiff: loadComparisonDiff, fetchFullFile: loadComparisonFullFile } = comparison;
    const commitFiles = activeDiffScope === 'commit' ? comparison.files : null;
    const commitFilesError = activeDiffScope === 'commit' ? comparison.error : null;
    const branchFiles = activeDiffScope === 'branch' ? comparison.files : null;
    const branchFilesError = activeDiffScope === 'branch' ? comparison.error : null;

    // Range diffs are fetched per expanded file: unlike working/staged diffs
    // there is no per-file cache channel, so patch data lives in a range-keyed
    // local cache. Stale completions from a previous range cannot write into
    // the new range's cache (see useRangeKeyedCache).
    const comparisonRangeKey = comparison.files ? (activeDiffScope === 'pr'
        ? JSON.stringify([comparison.key, comparison.revision]) : comparison.key) : null;
    const comparisonPathsKey = React.useMemo(
        () => (activeDiffScope === 'branch' || activeDiffScope === 'commit' || activeDiffScope === 'pr' ? Array.from(expandedFiles).sort().join('\0') : ''),
        [activeDiffScope, expandedFiles]
    );

    const fetchComparisonDiffEntry = React.useCallback(
        async (filePath: string, fullContext = false): Promise<ComparisonDiffResult> => {
            try {
                const response = await loadComparisonDiff(filePath, fullContext ? FULL_CONTEXT_DIFF_LINES : DEFAULT_CONTEXT_DIFF_LINES);
                return { status: 'ready', data: createTextDiffDataFromPatch(filePath, response.diff, fullContext ? 'full' : 'patch') };
            } catch (error) {
                return { status: 'error', message: error instanceof Error ? error.message : t('diffView.state.failedToLoadDiff') };
            }
        },
        [loadComparisonDiff, t]
    );
    // Branch and commit diffs are re-read from git with the whole file as
    // context; a PR diff comes from GitHub at fixed context, so its full view
    // is built from both sides of the file as GitHub has them.
    const fetchComparisonFullFileEntry = React.useCallback(
        async (filePath: string): Promise<ComparisonDiffResult> => {
            try {
                const { original, modified } = await loadComparisonFullFile(filePath);
                // Complete-file metadata, like the git-backed full patches: the
                // viewer keeps the highlighted partial diff on screen until this
                // one is highlighted, then replays the requested expansion.
                const fileDiff = parseDiffFromFile({ name: filePath, contents: original }, { name: filePath, contents: modified });
                return { status: 'ready', data: { original, modified, fileDiff, contextMode: 'full' } };
            } catch (error) {
                return { status: 'error', message: error instanceof Error ? error.message : t('diffView.state.failedToLoadDiff') };
            }
        },
        [loadComparisonFullFile, t]
    );
    const loadFullComparisonDiff = React.useMemo(
        () => activeDiffScope === 'branch' || activeDiffScope === 'commit'
            ? (filePath: string) => fetchComparisonDiffEntry(filePath, true)
            : activeDiffScope === 'pr'
            ? fetchComparisonFullFileEntry
            : undefined,
        [activeDiffScope, fetchComparisonDiffEntry, fetchComparisonFullFileEntry]
    );

    // A status read re-reads the Branch file list; each expanded file then
    // re-reads its patch only when its own revision moved.
    const branchDiffRevisions = React.useMemo(
        () => activeDiffScope === 'branch' ? branchPathRevisions(branchFiles, branchRevision) : undefined,
        [activeDiffScope, branchFiles, branchRevision]
    );
    const comparisonDiffData = useRangeKeyedCache<ComparisonDiffResult>(
        comparisonRangeKey,
        visible ? comparisonPathsKey : '',
        comparisonRangeKey ? fetchComparisonDiffEntry : null,
        EMPTY_COMPARISON_DIFF,
        JSON.stringify([activeDiffScope === 'pr' ? comparison.revision : 0, comparisonRetryRevision]),
        branchDiffRevisions
    );

    const branchFileCount = branchFiles?.length ?? null;

    const changedFiles: FileEntry[] = React.useMemo(() => {
        if (activeDiffScope === 'commit' || activeDiffScope === 'pr') {
            return (comparison.files ?? []).map((file) => ({
                path: file.path, index: '', working_dir: file.status,
                insertions: file.insertions, deletions: file.deletions, isNew: file.status === 'A',
            }));
        }
        if (activeDiffScope === 'branch') {
            return (branchFiles ?? [])
                .map((file) => ({
                    path: file.path,
                    index: '',
                    working_dir: file.status,
                    insertions: 0,
                    deletions: 0,
                    isNew: file.status === 'A',
                }))
                .sort((a, b) => a.path.localeCompare(b.path));
        }

        if (activeDiffScope === 'turn') {
            return lastTurnDiffs
                .map((diff) => ({
                    path: diff.file ?? '',
                    index: '',
                    working_dir: statusToGitCode(diff.status),
                    insertions: diff.additions ?? 0,
                    deletions: diff.deletions ?? 0,
                    isNew: diff.status === 'added',
                }))
                .filter((file) => file.path)
                .sort((a, b) => a.path.localeCompare(b.path));
        }

        if (!status?.files) return [];
        const diffStats = status.diffStats;
        const includeFile = activeDiffScope === 'staged'
            ? isStagedStatusFile
            : activeDiffScope === 'working'
                ? isWorkingStatusFile
                : () => true;

        const statsForFile = (filePath: string): { insertions: number; deletions: number } => {
            const staged = diffStats?.staged?.[filePath];
            const working = diffStats?.working?.[filePath];
            if (activeDiffScope === 'staged') {
                return { insertions: staged?.insertions ?? 0, deletions: staged?.deletions ?? 0 };
            }
            if (activeDiffScope === 'working') {
                return { insertions: working?.insertions ?? 0, deletions: working?.deletions ?? 0 };
            }
            return {
                insertions: (staged?.insertions ?? 0) + (working?.insertions ?? 0),
                deletions: (staged?.deletions ?? 0) + (working?.deletions ?? 0),
            };
        };

        return status.files
            .filter(includeFile)
            .map((file) => {
                const stats = statsForFile(file.path);
                return {
                    ...file,
                    insertions: stats.insertions,
                    deletions: stats.deletions,
                    isNew: isNewStatusFile(file),
                };
            })
            .sort((a, b) => a.path.localeCompare(b.path));
    }, [activeDiffScope, branchFiles, comparison.files, lastTurnDiffs, status]);

    const changedFilePathsKey = React.useMemo(
        () => changedFiles.map((file) => file.path).join('\0'),
        [changedFiles],
    );

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
    }, [captureScrollAnchor, clearDiffCache, effectiveDirectory, fetchStatus, git, refreshScope, visible]);

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
    }, [fileDiffRefreshNonce]);

    // Handle pending diff file from external navigation
    React.useEffect(() => {
        if (!visible || (activeDiffScope !== 'all' && !pendingDiffScope)) {
            return;
        }

        if (pendingDiffFile) {
            if (pendingDiffScope) {
                setActiveDiffScope(pendingDiffScope);
            }
            setDisplayFile(pendingDiffFile);
            setDisplayFileStaged(pendingDiffScope === 'staged' || (!pendingDiffScope && pendingDiffStaged));
            setPendingDiffFile(null);
            shouldPinAfterAlignRef.current = true;
            pendingScrollTargetRef.current = pendingDiffFile;
            expandStackedFile(pendingDiffFile);
            setScrollRequestNonce((value) => value + 1);
        }
    }, [activeDiffScope, expandStackedFile, pendingDiffFile, pendingDiffScope, pendingDiffStaged, setPendingDiffFile, visible]);

    React.useEffect(() => {
        if (activeDiffScope === 'all') {
            return;
        }

        const normalizedTarget = targetFilePath?.trim();
        if (!normalizedTarget) {
            return;
        }

        setDisplayFile(normalizedTarget);
        setDisplayFileStaged(activeDiffScope === 'staged');

        shouldPinAfterAlignRef.current = true;
        pendingScrollTargetRef.current = normalizedTarget;
        expandStackedFile(normalizedTarget);
        setScrollRequestNonce((value) => value + 1);
    }, [activeDiffScope, expandStackedFile, targetFilePath]);

    React.useEffect(() => {
        if (!displayFile) {
            return;
        }

        const stillExists = changedFiles.some((file) => file.path === displayFile);
        if (!stillExists) {
            setDisplayFile(null);
            setDisplayFileStaged(false);
        }
    }, [changedFiles, displayFile]);

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

    const closeReviewDialog = React.useCallback(() => setReviewDialogOpen(false), []);
    const { submitting: reviewFlowSubmitting, start: handleStartReviewFlow } = useReviewFlowStart(currentSessionId, rootDirectory, closeReviewDialog);

    const scrollToFile = React.useCallback((path: string): boolean => {
        const node = fileSectionRefs.current.get(path);
        const scrollRoot = diffScrollRef.current;
        if (!node || !scrollRoot) {
            return false;
        }

        const scrollOffset = node.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top;
        scrollRoot.scrollTo({ top: scrollRoot.scrollTop + scrollOffset, behavior: 'auto' });
        return true;
    }, []);

    // Which side of a file's diff is showing: the scope can force it, otherwise
    // only the file the user opened on the staged side is staged.
    const getFileStaged = React.useCallback((path: string) => {
        if (forcedStaged !== null) {
            return forcedStaged;
        }
        return displayFileStaged && path === displayFile;
    }, [displayFile, displayFileStaged, forcedStaged]);

    React.useEffect(() => {
        const target = pendingScrollTargetRef.current;
        if (!visible || !target) return;

        let attempts = 0;
        const maxAttempts = 20;
        let cancelled = false;

        const cancelPending = (clearPinnedTarget = true) => {
            if (cancelled) {
                return;
            }
            cancelled = true;
            pendingScrollTargetRef.current = null;
            shouldPinAfterAlignRef.current = false;
            if (clearPinnedTarget) {
                setPinnedStackedTarget(null);
            }
            if (pendingScrollFrameRef.current !== null) {
                window.cancelAnimationFrame(pendingScrollFrameRef.current);
                pendingScrollFrameRef.current = null;
            }
        };

        const tryAlign = () => {
            if (cancelled) {
                pendingScrollFrameRef.current = null;
                return;
            }
            const currentTarget = pendingScrollTargetRef.current;
            if (!currentTarget) {
                cancelPending();
                pendingScrollFrameRef.current = null;
                return;
            }

            const result = scrollToFile(currentTarget);
            if (!result) {
                attempts += 1;
                if (attempts < maxAttempts) {
                    pendingScrollFrameRef.current = window.requestAnimationFrame(tryAlign);
                } else {
                    cancelPending();
                    pendingScrollFrameRef.current = null;
                }
                return;
            }

            if (pinSelectedFileHeaderToTopOnNavigate && shouldPinAfterAlignRef.current) {
                setPinnedStackedTarget(currentTarget);
                cancelPending(false);
                return;
            }
            cancelPending();
        };

        pendingScrollFrameRef.current = window.requestAnimationFrame(tryAlign);

        return () => {
            cancelled = true;
            if (pendingScrollFrameRef.current !== null) {
                window.cancelAnimationFrame(pendingScrollFrameRef.current);
                pendingScrollFrameRef.current = null;
            }
        };
    }, [pinSelectedFileHeaderToTopOnNavigate, scrollRequestNonce, scrollToFile, visible]);

    const handleSelectFile = React.useCallback((value: string) => {
        void value;
    }, []);

    const isTreeMode = diffFileListMode === 'tree' && !isMobileLayout;
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
    }, [cancelPendingScrollAlignment, expandStackedFile, isTreeMode, scrollToFile]);

    // Step review to the adjacent changed file (alt+arrow): selects, expands
    // a collapsed section, and scrolls to it. Window-level because the diff
    // surface has no persistent focus target; guarded off editable fields.
    React.useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (!visible) return;
            if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            const target = event.target;
            if (target instanceof HTMLElement && (
                target.isContentEditable
                || target.tagName === 'INPUT'
                || target.tagName === 'TEXTAREA'
                || target.closest('[role="dialog"]')
            )) {
                return;
            }
            event.preventDefault();
            if (navigationFiles.length === 0) return;
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            const currentPath = isTreeMode ? treeSelectedFile?.path : displayFile;
            const index = currentPath ? navigationFiles.findIndex((file) => file.path === currentPath) : -1;
            const nextIndex = index === -1
                ? (delta > 0 ? 0 : navigationFiles.length - 1)
                : index + delta;
            const next = navigationFiles[nextIndex];
            if (!next) return;
            handleSelectFileAndScroll(next.path);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [displayFile, handleSelectFileAndScroll, isTreeMode, navigationFiles, treeSelectedFile, visible]);

    // ----- Find in diff -----
    // Files the bar can search. `load` mirrors the viewer's own read: the side
    // it shows, the context it shows (a file whose collapsed context the user
    // expanded shows the whole file), and for a nested repository's row, the
    // files read from that repository. A range scope reads a file's patch
    // through the same fetchComparisonDiffEntry the expanded entries use (that
    // call does not write into the range cache, so an unexpanded file the bar
    // read is fetched again when it is later expanded).
    const [findFullContextFiles, setFindFullContextFiles] = React.useState<ReadonlySet<string>>(() => new Set());
    const handleFullContextChange = React.useCallback((path: string, full: boolean) => {
        setFindFullContextFiles((previous) => {
            if (previous.has(path) === full) return previous;
            const next = new Set(previous);
            if (full) next.add(path);
            else next.delete(path);
            return next;
        });
    }, []);

    const readNestedRepositoryForFind = React.useCallback(async (
        rowPath: string,
        layout: DiffFindLayout,
        revision: string,
    ): Promise<DiffFindNestedSources | null> => {
        if (!effectiveDirectory) return null;
        const nestedDirectory = toAbsolutePath(effectiveDirectory, rowPath);
        const status = await git.getGitStatus(nestedDirectory, { fresh: true });
        // Same reads as NestedRepositoryFileDiff: the side the row shows, at
        // patch context. Keys are the row path plus the nested path, the key
        // that row's viewers register under.
        return {
            nestedSources: toNestedFileEntries(status).map((nestedFile) => ({
                filePath: `${rowPath}${nestedFile.path}`,
                layout,
                revision,
                load: async () => {
                    if (isImageFile(nestedFile.path)) return null;
                    const staged = isStagedStatusFile(nestedFile) && !isWorkingStatusFile(nestedFile);
                    const response = await git.getGitDiff(nestedDirectory, { path: nestedFile.path, staged, contextLines: DEFAULT_CONTEXT_DIFF_LINES });
                    const data = { ...createTextDiffDataFromPatch(nestedFile.path, response.diff, 'patch'), submodule: response.submodule };
                    return resolveFindDiff(diffDataToFileDiff(nestedFile.path, data), diffHideWhitespace);
                },
            })),
        };
    }, [diffHideWhitespace, effectiveDirectory, git]);

    // The bar reads files one at a time; the first local read asks for every
    // file of its side and context in one request (`findDiffBatch.ts`), and a
    // runtime without the batched read (VS Code) reads each file on its own.
    const [readFindDiffBatch] = React.useState(createFindDiffBatchReader);
    const diffFindSourcesRef = React.useRef<readonly DiffFindSource[]>([]);
    const readBatchedDiffForFind = React.useCallback((
        directory: string,
        filePath: string,
        revision: string,
        staged: boolean,
        fullContext: boolean,
    ): Promise<GitPathDiffBatchEntry | null> => {
        if (!git.getGitDiffs) return Promise.resolve(null);
        const peers = diffFindSourcesRef.current
            .filter((source) => !isImageFile(source.filePath)
                && getFileStaged(source.filePath) === staged
                && findFullContextFiles.has(source.filePath) === fullContext)
            .map((source) => ({ filePath: source.filePath, revision: source.revision ?? '' }));
        return readFindDiffBatch({
            directory,
            filePath,
            revision,
            staged,
            contextLines: fullContext ? FULL_CONTEXT_DIFF_LINES : DEFAULT_CONTEXT_DIFF_LINES,
            peers,
            getGitDiffs: (target, options) => git.getGitDiffs?.(target, options) ?? Promise.resolve([]),
        });
    }, [findFullContextFiles, getFileStaged, git, readFindDiffBatch]);

    const loadFileDiffForFind = React.useCallback(async (
        file: FileEntry,
        revision: string,
    ): Promise<FileDiffMetadata | DiffFindNestedSources | null> => {
        const filePath = file.path;
        const fullContext = findFullContextFiles.has(filePath);
        if (activeDiffScope === 'turn') {
            const data = lastTurnDiffData.get(filePath);
            return resolveFindDiff(data ? diffDataToFileDiff(filePath, data) : null, diffHideWhitespace);
        }
        if (activeDiffScope === 'branch' || activeDiffScope === 'commit' || activeDiffScope === 'pr') {
            const entry = comparisonDiffData.get(filePath);
            if (!fullContext && entry?.status === 'ready') {
                return resolveFindDiff(diffDataToFileDiff(filePath, entry.data), diffHideWhitespace);
            }
            // Reserved: the range cache owns this read; the revision moves when it lands.
            if (!fullContext && entry?.status === 'loading') return null;
            const result = fullContext && loadFullComparisonDiff
                ? await loadFullComparisonDiff(filePath)
                : await fetchComparisonDiffEntry(filePath);
            if (result.status !== 'ready') throw new Error(result.status === 'error' ? result.message : 'Diff not loaded');
            return resolveFindDiff(diffDataToFileDiff(filePath, result.data), diffHideWhitespace);
        }
        if (!effectiveDirectory || isImageFile(filePath)) return null;
        // Search exactly the side the viewer renders. `getGitDiff` reads the
        // unstaged (index -> working tree) side when `staged` is false and the
        // staged (HEAD -> index) side when it is true, the same read the viewer
        // does. `getGitFileDiff`'s unstaged read is the combined HEAD -> working
        // tree diff, a different side, so it must not be searched here. Nothing
        // is written to the shared diffCache, which holds `getGitFileDiff`
        // output for the viewer's fallback and the prefetcher.
        const staged = getFileStaged(filePath);
        const contextLines = fullContext ? FULL_CONTEXT_DIFF_LINES : DEFAULT_CONTEXT_DIFF_LINES;
        let response: Awaited<ReturnType<typeof git.getGitDiff>>;
        try {
            const batched = await readBatchedDiffForFind(effectiveDirectory, filePath, revision, staged, fullContext);
            if (batched && !batched.ok && batched.reason) throw new GitPathUnavailableError(batched.error, batched.reason);
            response = batched?.ok
                ? batched.diff
                : await git.getGitDiff(effectiveDirectory, { path: filePath, staged, contextLines });
        } catch (error) {
            if (!(error instanceof GitPathUnavailableError)) throw error;
            if (error.reason === 'nested_repository') return readNestedRepositoryForFind(filePath, getLayoutForFile(file), revision);
            // Gone since the listing, or a folder Git keeps as one row: the
            // entry shows a note and there is nothing to search.
            return null;
        }
        const next = { ...createTextDiffDataFromPatch(filePath, response.diff, fullContext ? 'full' : 'patch'), submodule: response.submodule };
        return resolveFindDiff(diffDataToFileDiff(filePath, next), diffHideWhitespace);
    }, [activeDiffScope, comparisonDiffData, diffHideWhitespace, effectiveDirectory, fetchComparisonDiffEntry, findFullContextFiles, getFileStaged, getLayoutForFile, git, lastTurnDiffData, loadFullComparisonDiff, readBatchedDiffForFind, readNestedRepositoryForFind]);

    // `diffFindSources` must stay identity-stable across renders, so `load`
    // reads the latest reader through this ref instead of capturing it.
    const loadFileDiffForFindRef = React.useRef(loadFileDiffForFind);
    loadFileDiffForFindRef.current = loadFileDiffForFind;

    // `revision` is what the hook re-reads on: hiding whitespace changes the
    // rendered diff, expanding a file's context shows the whole file, the side
    // (staged vs working) changes which content is searched, a live diff's
    // refresh signal moves with an edit, and a range or turn payload replaced
    // by a new read changes the content. Layout is deliberately excluded. The
    // range and turn maps are read through scope-gated handles so another
    // scope keeps `sources` identity-stable.
    const findRangeEntries = activeDiffScope === 'branch' || activeDiffScope === 'commit' || activeDiffScope === 'pr'
        ? comparisonDiffData
        : null;
    const findTurnEntries = activeDiffScope === 'turn' ? lastTurnDiffData : null;
    // The local read path (all/working/staged) resolves a per-file side; the
    // range and turn paths ignore it. Gating the side token on this keeps range
    // `sources` identity-stable when the selected file moves.
    const findUsesLocalRead = activeDiffScope === 'all' || activeDiffScope === 'working' || activeDiffScope === 'staged';
    const diffFindSources = React.useMemo<DiffFindSource[]>(
        () => changedFiles.map((file) => {
            const rangeEntry = findRangeEntries?.get(file.path);
            const content = findRangeEntries
                ? `${rangeEntry?.status ?? 'absent'}:${findPayloadRevision(rangeEntry)}`
                : findTurnEntries
                    ? findPayloadRevision(findTurnEntries.get(file.path))
                    : findUsesLocalRead
                        ? `${getFileStaged(file.path) ? 'staged' : 'unstaged'}:${workingTreeRevision + (fileDiffRefreshNonce.get(file.path) ?? 0)}`
                        : 'local';
            const revision = `${diffHideWhitespace ? 'hide' : 'show'}|${findFullContextFiles.has(file.path) ? 'full' : 'patch'}|${content}`;
            return {
                filePath: file.path,
                layout: getLayoutForFile(file),
                revision,
                load: () => loadFileDiffForFindRef.current(file, revision),
            };
        }),
        [changedFiles, diffHideWhitespace, fileDiffRefreshNonce, findFullContextFiles, findRangeEntries, findTurnEntries, findUsesLocalRead, getFileStaged, getLayoutForFile, workingTreeRevision],
    );

    diffFindSourcesRef.current = diffFindSources;
    const diffFind = useDiffFind({ sources: diffFindSources });

    // Bumped with each jump so the entry holding the match renders it even when
    // it is behind "Render anyway", and a nested repository opens its file.
    const [findReveal, setFindReveal] = React.useState<DiffFindReveal | null>(null);
    const changedFilesRef = React.useRef(changedFiles);
    changedFilesRef.current = changedFiles;
    const revealFindMatch = React.useCallback((match: DiffFindMatch) => {
        // A nested repository's file is keyed under its row's `dir/` path.
        const rowPath = changedFilesRef.current.find((file) => isFindRevealFor(file.path, match.filePath))?.path ?? match.filePath;
        setFindReveal((previous) => ({ key: match.filePath, nonce: (previous?.nonce ?? 0) + 1 }));
        // Showing another file shows its default side, like every other way of
        // selecting it; the side its matches were read from depends on it.
        if (isTreeMode && rowPath !== displayFile) {
            setDisplayFile(rowPath);
            setDisplayFileStaged(activeDiffScope === 'staged');
        }
        expandStackedFile(rowPath);
        scrollToFile(rowPath);
    }, [activeDiffScope, displayFile, expandStackedFile, isTreeMode, scrollToFile]);

    const { registerViewer: registerViewerRef, openOnWord: handleFindWordRequest, focusNonce: findFocusNonce } = useDiffFindSurface({
        find: diffFind,
        visible,
        rootRef: diffRootRef,
        reveal: revealFindMatch,
    });

    // The header toggle picks the layout for every diff from now on: it writes
    // the Appearance setting and drops the per-file choices.
    const handleHeaderLayoutChange = React.useCallback((mode: DiffViewMode) => {
        setDiffLayoutForAllFiles(mode === 'side-by-side' ? 'side-by-side' : 'inline');
    }, [setDiffLayoutForAllFiles]);

    const [openingEditorFilePath, setOpeningEditorFilePath] = React.useState<string | null>(null);

    const openFileInEditorAtChange = React.useCallback(async (filePath: string, cachedDiffData: DiffData | null) => {
        if (!rootDirectory || !effectiveDirectory || !filePath) {
            return;
        }

        setOpeningEditorFilePath(filePath);
        const runtimeKey = getRuntimeKey();
        try {
            let targetLine: number | null = null;

            if (cachedDiffData?.patch && !cachedDiffData.isBinary && !isImageFile(filePath)) {
                targetLine = getFirstChangedModifiedLineFromPatch(cachedDiffData.patch);
            } else if (cachedDiffData && cachedDiffData.contextMode === 'full' && !cachedDiffData.isBinary && !isImageFile(filePath)) {
                targetLine = getFirstChangedModifiedLine(cachedDiffData.original, cachedDiffData.modified);
            }

            if (targetLine === null) {
                try {
                    const patchResponse = await git.getGitDiff(effectiveDirectory, {
                        path: filePath,
                        staged: activeDiffStaged,
                        contextLines: 3,
                    });
                    targetLine = getFirstChangedModifiedLineFromPatch(patchResponse.diff);
                } catch {
                    targetLine = null;
                }
            }

            let diffForNavigation = cachedDiffData;
            if (targetLine === null || !diffForNavigation) {
                const response = await git.getGitFileDiff(effectiveDirectory, { path: filePath, staged: activeDiffStaged });
                const fetchedDiff = {
                    original: response.original ?? '',
                    modified: response.modified ?? '',
                    isBinary: response.isBinary,
                    submodule: response.submodule,
                };
                diffForNavigation = fetchedDiff;
                if (!activeDiffStaged) {
                    setDiff(effectiveDirectory, filePath, fetchedDiff, runtimeKey);
                }
            }

            const resolvedTargetLine = targetLine ?? ((diffForNavigation.isBinary || isImageFile(filePath))
                ? 1
                : getFirstChangedModifiedLine(diffForNavigation.original, diffForNavigation.modified));

            const absolutePath = toAbsolutePath(effectiveDirectory, filePath);
            const openValidation = await validateContextFileOpen(files, absolutePath, { directory: effectiveDirectory });
            if (!openValidation.ok) {
                toastContextFileOpenFailure(absolutePath, openValidation);
                return;
            }

            // The editor tab belongs to the panel's root. Keyed by the nested
            // repository being diffed, it would park under a key the panel
            // never displays.
            openContextFileAtLine(
                rootDirectory,
                absolutePath,
                resolvedTargetLine,
                1,
            );
        } finally {
            setOpeningEditorFilePath((current) => (current === filePath ? null : current));
        }
    }, [activeDiffStaged, effectiveDirectory, files, git, openContextFileAtLine, rootDirectory, setDiff]);
    const handleOpenInEditor = React.useCallback((filePath: string, diffData: DiffData | null) => {
        void openFileInEditorAtChange(filePath, diffData);
    }, [openFileInEditorAtChange]);
    const handleRetryComparisonDiff = React.useCallback(() => setComparisonRetryRevision((revision) => revision + 1), []);

    const renderStackedDiffView = () => {
        if (!effectiveDirectory) return null;
        const renderEntry = (file: FileEntry, isSingleFile = false) => {
            const isExpanded = isSingleFile || expandedFiles.has(file.path);
            return (
            <MultiFileDiffEntry
                // Only an expanded entry loads while shown; a collapsed one
                // stays out of the re-render when the view is shown or hidden.
                visible={visible && isExpanded}
                key={`${getRuntimeKey()}:${effectiveDirectory}:${file.path}`}
                directory={effectiveDirectory}
                file={file}
                layout={getLayoutForFile(file)}
                wrapLines={diffWrapLines}
                hideWhitespace={diffHideWhitespace}
                isSelected={false}
                isExpanded={isExpanded}
                isMounted={isSingleFile || mountedStackedFiles.has(file.path) || file.path === pinnedStackedTarget}
                onSelect={handleSelectFile}
                onExpandedChange={handleStackedEntryExpandedChange}
                registerSectionRef={registerSectionRef}
                registerViewerRef={registerViewerRef}
                onFindWordRequest={handleFindWordRequest}
                onFullContextChange={handleFullContextChange}
                findReveal={findReveal && isFindRevealFor(file.path, findReveal.key) ? findReveal : null}
                showOpenInEditorAction={showOpenInEditorAction && activeDiffScope !== 'turn' && !foreign}
                isOpeningInEditor={openingEditorFilePath === file.path}
                onOpenInEditor={handleOpenInEditor}
                staged={getFileStaged(file.path)}
                readOnlyActions={activeDiffScope === 'branch' || activeDiffScope === 'commit' || activeDiffScope === 'pr'}
                hunkActionsEnabled={activeDiffScope === 'all' || activeDiffScope === 'working' || activeDiffScope === 'staged'}
                contentRevision={workingTreeRevision + (fileDiffRefreshNonce.get(file.path) ?? 0)}
                comparisonDiff={activeDiffScope === 'branch' || activeDiffScope === 'commit' || activeDiffScope === 'pr'
                    ? comparisonDiffData.get(file.path) ?? EMPTY_COMPARISON_DIFF
                    : undefined}
                commentOrigin={commentOrigin}
                onRetryComparisonDiff={handleRetryComparisonDiff}
                loadFullComparisonDiff={loadFullComparisonDiff}
                initialDiffData={
                    activeDiffScope === 'turn'
                        ? lastTurnDiffData.get(file.path) ?? null
                        : null
                }
            />
            );
        };

        return (
            <div ref={fileTreeLayoutRef} className={cn('flex min-w-0 flex-1 min-h-0 h-full', flushContent ? 'gap-0' : 'gap-3 px-3 pb-3 pt-2')}>
                {isTreeMode && (
                    <>
                        {/* Clamped by CSS too: a width stored in a wide panel must not swallow a narrow one. */}
                        <section
                            className="flex max-w-[50%] flex-shrink-0 flex-col"
                            style={{ width: `${fileTreeWidth}px` }}
                        >
                            <FileTree
                                changedFiles={changedFiles}
                                selectedFile={treeSelectedFile?.path ?? null}
                                onSelectFile={handleSelectFileAndScroll}
                            />
                        </section>
                        <div
                            role="separator"
                            aria-orientation="vertical"
                            aria-label={t('diffView.fileTree.resize')}
                            tabIndex={0}
                            onPointerDown={handleFileTreeResizeStart}
                            onKeyDown={handleFileTreeResizeKey}
                            className={cn(
                                'relative w-px shrink-0 cursor-col-resize bg-[var(--interactive-border)]/40',
                                'before:absolute before:inset-y-0 before:-inset-s-1 before:-inset-e-1 before:content-[\'\']',
                                'hover:bg-interactive-selection focus-visible:bg-interactive-selection focus-visible:outline-none',
                                draggingFileTree && 'bg-interactive-selection'
                            )}
                        />
                    </>
                )}
                {showFileSidebar && !isTreeMode && (
                    <section className="hidden lg:flex w-72 flex-col rounded-xl border border-edge bg-background/70 overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-1.5 border-b border-edge-muted">
                            <span className="typography-ui-header font-semibold text-foreground">{t('diffView.section.files')}</span>
                            <span className="typography-meta text-muted-foreground">{changedFiles.length}</span>
                        </div>
                        <FileList
                            changedFiles={changedFiles}
                            selectedFile={null}
                            onSelectFile={handleSelectFileAndScroll}
                        />
                    </section>
                )}
                <div className="relative flex-1 min-w-0 min-h-0 h-full">
                    {diffFind.isOpen && (
                        <DiffFindBar
                            query={diffFind.query}
                            onQueryChange={diffFind.setQuery}
                            total={diffFind.matches.length}
                            currentIndex={diffFind.currentIndex}
                            isSearching={diffFind.isSearching}
                            failedCount={diffFind.failedCount}
                            onNext={diffFind.next}
                            onPrevious={diffFind.previous}
                            onClose={diffFind.close}
                            focusNonce={findFocusNonce}
                        />
                    )}
                    <ScrollableOverlay
                        ref={diffScrollRef}
                        outerClassName="min-h-0 h-full"
                        className="[overflow-anchor:none]"
                        disableHorizontal
                        observeMutations={false}
                        preventOverscroll
                        data-diff-virtual-root
                    >
                        {/* The end space is the content's: padding on the scroller would hold a diff's sticky scrollbar that far above the panel's bottom. */}
                        <div className="flex flex-col [overflow-anchor:none] pb-16" data-diff-virtual-content>
                            {isTreeMode
                                ? treeSelectedFile && renderEntry(treeSelectedFile, true)
                                : changedFiles.map((file) => renderEntry(file))}
                        </div>
                    </ScrollableOverlay>
                </div>
            </div>
        );
    };

    const renderContent = () => {

        if (!effectiveDirectory) {
            return (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {t('diffView.state.selectSessionDirectory')}
                </div>
            );
        }

        if (activeDiffScope !== 'turn' && isLoadingStatus && !status) {
            return (
                <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />
                    {t('diffView.state.loadingRepositoryStatus')}
                </div>
            );
        }

        if (activeDiffScope !== 'turn' && isGitRepo === false) {
            return (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {t('diffView.state.notGitRepository')}
                </div>
            );
        }

        if (activeDiffScope === 'pr') {
            if (prComparison.diffUnavailable) return <ChangeRequestDiffUnavailable provider={prComparison.provider} />;
            if (!selectedPr || comparison.error) {
                return <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                    {!comparison.error && !prComparison.error && !prComparison.loading
                        && <Icon name="git-pull-request" className="size-6 text-muted-foreground" />}
                    <p className="typography-meta text-muted-foreground">{comparison.error ?? prComparison.error ?? (prComparison.loading
                        ? t(changeRequestCopy('session.githubPrPicker.loading.pullRequests', prChangeRequestTerm))
                        : t(changeRequestCopy('pullRequestComparison.pickAbove', prChangeRequestTerm)))}</p>
                    {(comparison.error || prComparison.error) && <Button variant="outline" size="sm" onClick={() => {
                        if (selectedPr) void comparison.refresh();
                        else void prComparison.refresh();
                    }}>{t('diffView.actions.retry')}</Button>}
                </div>;
            }
            if (!comparison.files) return <div className="flex flex-1 items-center justify-center gap-2 typography-meta text-muted-foreground">
                <Icon name="loader-4" className="size-4 animate-spin" />{t('diffView.state.loadingDiff')}
            </div>;
        }

        if (activeDiffScope === 'commit') {
            if (commitFilesError) {
                return <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                    <p className="typography-meta text-muted-foreground">{commitFilesError}</p>
                    <Button variant="outline" size="sm" onClick={() => void comparison.refresh()}>{t('diffView.actions.retry')}</Button>
                </div>;
            }
            if (!selectedCommitHash && !commitComparison.loading) {
                return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {commitComparison.error ?? t('commitComparison.noCommits')}
                </div>;
            }
            if (!commitFiles) {
                return <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />{t('diffView.state.loadingDiff')}
                </div>;
            }
        }

        if (activeDiffScope === 'branch') {
            // A base not found while the status or the binding (whose pull
            // request names it) still load is still being resolved, not missing.
            const baseInputsLoading = status === null || binding.status === 'idle' || binding.status === 'loading';
            if (!isBranchBaseResolved || (!qualifiedBranchBase && baseInputsLoading)) {
                return (
                    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                        <Icon name="loader-4" className="size-4 animate-spin" />
                        {t('diffView.branch.resolvingBase')}
                    </div>
                );
            }

            if (!qualifiedBranchBase) {
                return (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                        <Icon name="git-branch" className="size-6 text-muted-foreground" />
                        <div className="typography-ui-label font-semibold text-foreground">{t('diffView.branch.noBaseTitle')}</div>
                        <div className="max-w-sm typography-micro text-muted-foreground">{t('gitView.pr.toast.baseBranchRequired')}</div>
                    </div>
                );
            }

            if (branchFilesError) {
                return (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                        <div className="typography-ui-label font-semibold text-foreground">{t('diffView.branch.loadError')}</div>
                        <div className="max-w-sm typography-micro text-muted-foreground">{branchFilesError}</div>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void comparison.refresh()}
                        >
                            {t('diffView.actions.retry')}
                        </Button>
                    </div>
                );
            }

            if (branchFiles === null) {
                return (
                    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                        <Icon name="loader-4" className="size-4 animate-spin" />
                        {t('diffView.branch.loadingFiles')}
                    </div>
                );
            }
        }

        if (activeDiffScope === 'turn' && turnDiffError) {
            return (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-sm text-muted-foreground">
                    <div className="typography-ui-label font-semibold text-foreground">{t('diffView.state.failedToLoadDiff')}</div>
                    <div className="typography-meta max-w-[32rem] text-center">{turnDiffError}</div>
                    <button type="button" className="typography-ui-label text-primary hover:underline" onClick={() => { setTurnDiffError(null); retryTurnDiff(); }}>
                        {t('diffView.actions.retry')}
                    </button>
                </div>
            );
        }

        if (changedFiles.length === 0) {
            return (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {activeDiffScope === 'turn' ? t('diffView.state.noLastTurnChanges')
                        : activeDiffScope === 'pr' ? t('walkthrough.blocked.emptyDiff.description')
                        : activeDiffScope === 'commit' ? t('commitComparison.emptyDiff')
                        : activeDiffScope === 'branch' && qualifiedBranchBase ? t('diffView.branch.empty', { base: branchRefLabel(qualifiedBranchBase) })
                        : t('diffView.state.cleanWorkingTree')}
                </div>
            );
        }

        return renderStackedDiffView();
    };

    const showWalkthroughButton = changedFiles.length > 0 && showWalkthroughAction && (activeDiffScope !== 'pr' || Boolean(pullRequestContext));
    const openWalkthrough = () => {
        // Carry the scope across: opening the walkthrough
        // while looking at staged changes should review
        // staged changes, not whatever the panel showed last.
        const directory = effectiveDirectory ?? '';
        const localSource: WalkthroughTarget = {
            source: activeDiffScope === 'commit' && selectedCommitHash ? {
                kind: 'commit', hash: selectedCommitHash,
            } : activeDiffScope === 'branch' && qualifiedBranchBase && currentBranch ? {
                kind: 'branch',
                baseRef: qualifiedBranchBase,
                headRef: currentBranch,
            } : {
                kind: 'working-tree',
                scope: activeDiffScope === 'staged' || activeDiffScope === 'working'
                    ? activeDiffScope
                    : 'all',
            },
        };
        requestWalkthroughTarget(directory, activeDiffScope === 'pr' && selectedPr && pullRequestContext
            ? { source: selectedPr, context: pullRequestContext }
            : localSource);
        if (foreign && panelDirectory) openContextPanelTab(panelDirectory, { mode: 'walkthrough', targetDirectory: rootDirectory });
        else openContextSurface(rootDirectory ?? directory, 'walkthrough');
    };

    // A control moved into "More actions" as a menu item; a view option shows
    // a check while it is on. Null when the row does not show that control.
    const toolbarMenuItem = (option: keyof typeof DIFF_TOOLBAR_MENU_STEPS) => {
        switch (option) {
            case 'walkthrough':
                if (!showWalkthroughButton) return null;
                return { label: t('walkthrough.action.open'), icon: <Icon name="route" className="size-4" />, on: false, select: openWalkthrough };
            case 'tree':
                if (isMobileLayout) return null;
                return {
                    label: t('diffView.fileTree.showAsTree'),
                    icon: <Icon name="node-tree" className="size-4" />,
                    on: diffFileListMode === 'tree',
                    select: () => setDiffFileListMode(diffFileListMode === 'tree' ? 'flat' : 'tree'),
                };
            case 'wrap':
                return { label: t('diffView.actions.wrapLines'), icon: <Icon name="text-wrap" className="size-4" />, on: diffWrapLines, select: () => setDiffWrapLines(!diffWrapLinesStore) };
            case 'whitespace':
                return {
                    label: t('diffView.actions.hideWhitespace'),
                    icon: <Icon name="space" className="size-4" />,
                    on: diffHideWhitespace,
                    select: () => setDiffHideWhitespace(!diffHideWhitespace),
                };
            case 'layout': {
                const sideBySide = currentLayoutForAllFiles === 'side-by-side';
                return {
                    label: t('diffView.layout.sideBySide'),
                    icon: <Icon name="layout-column" className="size-4" />,
                    on: sideBySide,
                    select: () => handleHeaderLayoutChange(sideBySide ? 'unified' : 'side-by-side'),
                };
            }
        }
    };

    return (
        <div ref={diffRootRef} data-find-surface="" className="flex h-full flex-col overflow-hidden bg-background">
            <ContextPanelHeaderToolbar>
            <div ref={toolbarRef} className={cn('flex min-w-0 items-center gap-2', inPanelHeader ? 'flex-1 py-1 pe-1' : 'px-3 py-2 bg-background')}>
                {repositoryOptions ? (
                    <NestedRepoPicker
                        repositories={repositoryOptions}
                        selectedRepository={nestedGitDirectory ?? null}
                        onSelectRepository={(repository) => {
                            if (rootDirectory) selectNestedRepo(rootDirectory, repository);
                        }}
                        repositoryRoot={rootDirectory ?? undefined}
                    />
                ) : null}
                {!isMobile && !foreign && (
                    activeDiffScope !== 'all' ? (
                        <ChangeScopeSelector
                            scope={activeDiffScope}
                            workingCount={workingFileCount}
                            stagedCount={stagedFileCount}
                            turnCount={turnFileCount}
                            branchCount={branchFileCount}
                            commitCount={activeDiffScope === 'commit' ? commitFiles?.length ?? null : null}
                            prCount={activeDiffScope === 'pr' ? comparison.files?.length ?? null : null}
                            showCommitOption={!isVSCodeRuntime()}
                            showBranchOption={showBranchOption}
                            changeRequestTerm={prChangeRequestTerm}
                            onScopeChange={(scope) => {
                                setActiveDiffScope(scope);
                                onDiffScopeChange?.(scope);
                            }}
                        />
                    ) : (
                        <div className="flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground shrink-0">
                            <span className="typography-ui-label font-semibold text-foreground">
                                {isLoadingStatus && !status
                                    ? t('diffView.state.loadingChanges')
                                    : (changedFiles.length === 1
                                        ? t('diffView.summary.changedFilesSingle', { count: changedFiles.length })
                                        : t('diffView.summary.changedFilesPlural', { count: changedFiles.length }))}
                            </span>
                        </div>
                    )
                )}
                {activeDiffScope === 'branch' && (
                    <BranchComparisonSelector
                        key={JSON.stringify([effectiveDirectory, currentBranch])}
                        branches={branches?.all ?? []}
                        currentBranch={currentBranch}
                        base={qualifiedBranchBase}
                        automatic={branchBaseSource !== 'chosen'}
                        onSelect={(base) => {
                            if (effectiveDirectory && currentBranch) setBaseOverride(effectiveDirectory, currentBranch, base);
                        }}
                        onSelectAutomatic={() => {
                            if (effectiveDirectory && currentBranch) clearBaseOverride(effectiveDirectory, currentBranch);
                        }}
                    />
                )}
                {activeDiffScope === 'commit' && (
                    <CommitComparisonSelector
                        key={JSON.stringify([effectiveDirectory, currentBranch])}
                        commits={commitComparison.commits}
                        selectedHash={selectedCommitHash}
                        loading={commitComparison.loading}
                        error={commitComparison.error}
                        onSelect={commitComparison.select}
                        onRefresh={() => void commitComparison.refresh()}
                    />
                )}
                {activeDiffScope === 'pr' && <>
                    <PullRequestComparisonSelector key={JSON.stringify([runtimeKey, effectiveDirectory, currentBranch])} comparison={prComparison} />
                    {selectedPr && <Button variant="ghost" size="sm" disabled={comparison.loading}
                        aria-label={t('session.githubIssuePicker.actions.refresh')} title={t('session.githubIssuePicker.actions.refresh')}
                        onClick={() => void comparison.refresh()}><Icon name="refresh" className="size-4" /></Button>}
                </>}
                {changedFiles.length > 0 && (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleExpandOrCollapseAll}
                        className={cn(
                            'diff-toolbar__expand-button h-7 flex-shrink-0 gap-1 px-1.5 text-muted-foreground hover:text-foreground',
                            'ms-auto',
                        )}
                        title={expandedFiles.size > 0 ? t('diffView.actions.collapseAll') : t('diffView.actions.expandAll')}
                    >
                        <Icon
                            name="expand-up-down"
                            className="size-4"
                        />
                        <span className="diff-toolbar__expand-label typography-ui-label">
                            {expandedFiles.size > 0 ? t('diffView.actions.collapseAll') : t('diffView.actions.expandAll')}
                        </span>
                    </Button>
                )}
                {changedFiles.length > 0 && showReviewAction && (
                    <Button
                        variant="default"
                        size="sm"
                        onClick={() => setReviewDialogOpen(true)}
                        disabled={reviewFlowSubmitting}
                        className="diff-toolbar__review-button h-7 flex-shrink-0 gap-1.5 px-2"
                        aria-label={t('diffView.actions.reviewAria')}
                    >
                        {reviewFlowSubmitting ? (
                            <Icon name="loader-4" className="size-4 animate-spin" />
                        ) : (
                            <Icon name="search-eye" className="size-4" />
                        )}
                        <span className="diff-toolbar__review-label typography-ui-label">
                            {t('diffView.actions.review')}
                        </span>
                    </Button>
                )}
                {showWalkthroughButton && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={openWalkthrough}
                        className={cn('diff-toolbar__walkthrough-button h-7 flex-shrink-0 gap-1.5 px-2', WALKTHROUGH_ACTION_CLASS)}
                        aria-label={t('walkthrough.action.open')}
                    >
                        <Icon name="route" className="size-4" />
                        <span className="diff-toolbar__walkthrough-label typography-ui-label">
                            {t('walkthrough.action.open')}
                        </span>
                    </Button>
                )}
                {changedFiles.length > 0 && !isMobileLayout && (
                    <span className="diff-toolbar__tree-toggle flex flex-shrink-0">
                        <ToolbarTooltipButton
                            label={t('diffView.fileTree.showAsTree')}
                            icon="node-tree"
                            pressed={diffFileListMode === 'tree'}
                            onClick={() => setDiffFileListMode(diffFileListMode === 'tree' ? 'flat' : 'tree')}
                        />
                    </span>
                )}
                {changedFiles.length > 0 && (
                    <span className="diff-toolbar__wrap-toggle flex flex-shrink-0">
                        <ToolbarTooltipButton
                            label={t('diffView.actions.wrapLines')}
                            icon="text-wrap"
                            pressed={diffWrapLines}
                            onClick={() => setDiffWrapLines(!diffWrapLinesStore)}
                        />
                    </span>
                )}
                {changedFiles.length > 0 && (
                    <span className="diff-toolbar__whitespace-toggle flex flex-shrink-0">
                        <ToolbarTooltipButton
                            label={t('diffView.actions.hideWhitespace')}
                            icon="space"
                            pressed={diffHideWhitespace}
                            onClick={() => setDiffHideWhitespace(!diffHideWhitespace)}
                        />
                    </span>
                )}
                {currentLayoutForAllFiles && (
                    <span className="diff-toolbar__layout-toggle flex flex-shrink-0">
                        <DiffViewToggle
                            mode={currentLayoutForAllFiles === 'side-by-side' ? 'side-by-side' : 'unified'}
                            onModeChange={handleHeaderLayoutChange}
                        />
                    </span>
                )}
                {changedFiles.length > 0 && (
                    <DropdownMenu onOpenChange={handleToolbarMenuOpenChange}>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="diff-toolbar__more flex-shrink-0">
                                    <DropdownMenuTrigger asChild>
                                        <ToolbarButton label={t('diffView.actions.moreActions')} icon="more" />
                                    </DropdownMenuTrigger>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" sideOffset={6}>{t('diffView.actions.moreActions')}</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="end" className="min-w-56">
                            {toolbarMenuOptions.map((option) => {
                                const item = toolbarMenuItem(option);
                                if (!item) return null;
                                return (
                                    <DropdownMenuItem key={option} className="flex items-center gap-2" onClick={item.select}>
                                        {item.icon}
                                        <span className="min-w-0 truncate typography-ui-label text-foreground">{item.label}</span>
                                        {item.on ? <Icon name="check" className="ms-auto size-4 text-foreground" /> : null}
                                    </DropdownMenuItem>
                                );
                            })}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>
            </ContextPanelHeaderToolbar>

            <ReviewFlowDialog
                open={reviewDialogOpen}
                onOpenChange={setReviewDialogOpen}
                projectDirectory={effectiveDirectory ?? null}
                submitting={reviewFlowSubmitting}
                onConfirm={handleStartReviewFlow}
            />

            {renderContent()}
        </div>
    );
};
