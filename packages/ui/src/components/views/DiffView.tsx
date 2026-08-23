import React from 'react';

import { useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useGitStore, useGitStatus, useIsGitRepo, useGitLoadingStatus } from '@/stores/useGitStore';
import { useGitBaseBranchStore, gitBaseBranchEntryKey } from '@/stores/useGitBaseBranchStore';
import { coerceDiffScope, branchRangeKey, isBranchScopeAvailable, isBranchScopeDefinitelyUnavailable, useRangeKeyedCache, useBoundedDirectoryRetry } from './branchDiffScope';
import { getBranchBase, getGitRangeDiff, getGitRangeFiles } from '@/lib/gitApi';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import type { GitStatus, GitRangeFileEntry } from '@/lib/api/types';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';

import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { getLanguageFromExtension, isImageFile } from '@/lib/toolHelpers';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { DiffViewToggle } from '@/components/chat/message/DiffViewToggle';
import type { DiffViewMode } from '@/components/chat/message/types';
import { ReviewFlowDialog, type ReviewFlowExecution } from '@/components/session/ReviewFlowDialog';
import { PierreDiffViewer } from './PierreDiffViewer';
import { useDeviceInfo } from '@/lib/device';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from "@/components/icon/Icon";
import { getContextFileOpenFailureMessage, validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import { sessionEvents } from '@/lib/sessionEvents';
import { findDiffScrollAnchor, getRestoredDiffScrollTop, type DiffScrollAnchor } from './diffScrollAnchor';
import { useI18n } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n/store';
import { fileDiffFromPatch } from '@/lib/diff/patchFileDiff';
import { isVSCodeRuntime } from '@/lib/desktop';
import { startReviewFlow } from '@/lib/reviewFlow';
import { WALKTHROUGH_ACTION_CLASS } from '@/components/views/walkthrough/walkthroughAction';
import { useWalkthroughStore } from '@/stores/useWalkthroughStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessages } from '@/sync/sync-context';
import { getFirstChangedModifiedLineFromPatch } from './diffPatchUtils';
import type { FileDiffMetadata } from '@pierre/diffs';

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
};
type DiffScope = 'all' | 'staged' | 'working' | 'turn' | 'branch';

type TurnSnapshotDiff = {
    file?: string;
    status?: string;
    before?: string;
    after?: string;
    patch?: string;
    additions?: number;
    deletions?: number;
};

/** Reservation slot for a branch range diff while its fetch is in flight. */
const EMPTY_BRANCH_DIFF_PLACEHOLDER: DiffData = {
    original: '',
    modified: '',
    isBinary: false,
    contextMode: 'patch',
};

/** Bounded retries for branch metadata in the context diff panel (see effect). */
const BRANCH_METADATA_MAX_ATTEMPTS = 3;

const BinaryDiffPlaceholder = React.memo(() => {
    const { t } = useI18n();
    return (
        <div className="rounded-lg border border-border/60 bg-background px-3 py-2">
            <div className="typography-meta text-muted-foreground">{t('diffView.binary.unavailable')}</div>
        </div>
    );
});

type ChangeDescriptor = {
    code: string;
    color: string;
    descriptionKey: I18nKey;
};

const CHANGE_DESCRIPTORS: Record<string, ChangeDescriptor> = {
    '?': { code: '?', color: 'var(--status-info)', descriptionKey: 'diffView.change.untracked' },
    A: { code: 'A', color: 'var(--status-success)', descriptionKey: 'diffView.change.new' },
    D: { code: 'D', color: 'var(--status-error)', descriptionKey: 'diffView.change.deleted' },
    R: { code: 'R', color: 'var(--status-info)', descriptionKey: 'diffView.change.renamed' },
    C: { code: 'C', color: 'var(--status-info)', descriptionKey: 'diffView.change.copied' },
    M: { code: 'M', color: 'var(--status-warning)', descriptionKey: 'diffView.change.modified' },
};

const DEFAULT_CHANGE_DESCRIPTOR = CHANGE_DESCRIPTORS.M;

const getChangeSymbol = (file: GitStatus['files'][number]): string => {
    const indexCode = file.index?.trim();
    const workingCode = file.working_dir?.trim();

    if (indexCode && indexCode !== '?') return indexCode.charAt(0);
    if (workingCode) return workingCode.charAt(0);

    return indexCode?.charAt(0) || workingCode?.charAt(0) || 'M';
};

const describeChange = (file: GitStatus['files'][number]): ChangeDescriptor => {
    const symbol = getChangeSymbol(file);
    return CHANGE_DESCRIPTORS[symbol] ?? DEFAULT_CHANGE_DESCRIPTOR;
};

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

const normalizePath = (value?: string | null): string =>
    (value || '').replace(/\\/g, '/').replace(/\/+$/, '');

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

const isBinaryPatch = (patch: string): boolean =>
    /^Binary files .+ differ$/m.test(patch) || /^GIT binary patch$/m.test(patch);

const listTurnDiffs = (value: unknown): TurnSnapshotDiff[] => {
    if (!Array.isArray(value)) return [];
    return value.filter((diff): diff is TurnSnapshotDiff => {
        if (!diff || typeof diff !== 'object') return false;
        return typeof (diff as TurnSnapshotDiff).file === 'string';
    });
};

const statusToGitCode = (status?: string): string => {
    if (status === 'added') return 'A';
    if (status === 'deleted') return 'D';
    return 'M';
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

interface ChangeScopeSelectorProps {
    scope: Extract<DiffScope, 'working' | 'staged' | 'turn' | 'branch'>;
    workingCount: number;
    stagedCount: number;
    turnCount: number;
    branchCount: number | null;
    showBranchOption: boolean;
    onScopeChange?: (scope: Extract<DiffScope, 'working' | 'staged' | 'turn' | 'branch'>) => void;
}

const ChangeScopeSelector = React.memo<ChangeScopeSelectorProps>(({
    scope,
    workingCount,
    stagedCount,
    turnCount,
    branchCount,
    showBranchOption,
    onScopeChange,
}) => {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(false);
    const currentCount = scope === 'staged' ? stagedCount : scope === 'turn' ? turnCount : scope === 'branch' ? (branchCount ?? 0) : workingCount;
    const currentLabel = scope === 'staged'
        ? t('diffView.scope.staged')
        : scope === 'turn'
            ? t('diffView.scope.lastTurn')
            : scope === 'branch'
                ? t('diffView.scope.branch')
                : t('diffView.scope.changed');

    return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className="flex h-7 flex-shrink-0 items-center gap-1.5 rounded-md px-2 typography-ui-label font-semibold text-foreground outline-none hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t('diffView.scope.selectorAria')}
                >
                    <span className="whitespace-nowrap">
                        {currentLabel}<span className="diff-toolbar__scope-count">: {currentCount}</span>
                    </span>
                    <Icon name="arrow-down-s" className="size-4 flex-shrink-0 opacity-60" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-40">
                <DropdownMenuRadioGroup
                    value={scope}
                    onValueChange={(value) => {
                        if (value === 'working' || value === 'staged' || value === 'turn' || value === 'branch') {
                            onScopeChange?.(value);
                            setOpen(false);
                        }
                    }}
                >
                    <DropdownMenuRadioItem value="working">
                        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                            <span>{t('diffView.scope.changed')}</span>
                            <span className="typography-meta text-muted-foreground">{workingCount}</span>
                        </span>
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="staged">
                        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                            <span>{t('diffView.scope.staged')}</span>
                            <span className="typography-meta text-muted-foreground">{stagedCount}</span>
                        </span>
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="turn">
                        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                            <span>{t('diffView.scope.lastTurn')}</span>
                            <span className="typography-meta text-muted-foreground">{turnCount}</span>
                        </span>
                    </DropdownMenuRadioItem>
                    {showBranchOption ? (
                        <DropdownMenuRadioItem value="branch">
                            <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                <span>{t('diffView.scope.branch')}</span>
                                <span className="typography-meta text-muted-foreground">{branchCount ?? '…'}</span>
                            </span>
                        </DropdownMenuRadioItem>
                    ) : null}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
});

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
                                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
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
                                    className="min-w-0 flex-1 truncate typography-meta"
                                    style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
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
                        <img
                            src={diff.original}
                            alt={t('diffView.image.originalAlt', { path: filePath })}
                            className={renderSideBySide ? "max-w-full max-h-[70vh] object-contain" : "max-w-full object-contain"}
                            style={{ imageRendering: 'auto' }}
                        />
                    </div>
                )}
                {hasModified && (
                    <div className={imageContainerClass}>
                        <span className="typography-meta text-muted-foreground font-medium">
                            {hasOriginal ? t('diffView.image.modified') : t('diffView.image.new')}
                        </span>
                        <img
                            src={diff.modified}
                            alt={t('diffView.image.modifiedAlt', { path: filePath })}
                            className={renderSideBySide ? "max-w-full max-h-[70vh] object-contain" : "max-w-full object-contain"}
                            style={{ imageRendering: 'auto' }}
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
  renderSideBySide: boolean;
  wrapLines: boolean;
}

const InlineDiffViewer = React.memo<InlineDiffViewerProps>(({
  filePath,
  diff,
  renderSideBySide,
  wrapLines,
}) => {
  const language = React.useMemo(
    () => getLanguageFromExtension(filePath) || 'text',
    [filePath]
  );

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
        original={diff.original}
        modified={diff.modified}
        fileDiff={diff.fileDiff}
        language={language}
        fileName={filePath}
        renderSideBySide={renderSideBySide}
        wrapLines={wrapLines}
        layout="inline"
      />
    </div>
  );
});

type FileDiffAction = 'stage' | 'unstage' | 'discard';

interface FileDiffActionsProps {
    filePath: string;
    staged: boolean;
    busyAction: FileDiffAction | null;
    disabled: boolean;
    onAction: (action: FileDiffAction) => void;
}

const FileDiffActions = React.memo<FileDiffActionsProps>(({
    filePath,
    staged,
    busyAction,
    disabled,
    onAction,
}) => {
    const { t } = useI18n();
    return (
        <div className="flex items-center gap-0.5 rounded-full border border-[var(--interactive-border)]/45 bg-[var(--surface-background)]/95 px-1 py-0.5 shadow-sm backdrop-blur-md">
            {staged ? (
                <FileDiffActionButton
                    label={t('gitView.changes.unstageFileAria', { path: filePath })}
                    icon="arrow-go-back"
                    loading={busyAction === 'unstage'}
                    disabled={disabled}
                    onClick={() => onAction('unstage')}
                />
            ) : (
                <>
                    <FileDiffActionButton
                        label={t('gitView.changes.revertFileAria', { path: filePath })}
                        icon="arrow-go-back"
                        loading={busyAction === 'discard'}
                        disabled={disabled}
                        tone="failure"
                        onClick={() => onAction('discard')}
                    />
                    <FileDiffActionButton
                        label={t('gitView.changes.stageFileAria', { path: filePath })}
                        icon="add"
                        loading={busyAction === 'stage'}
                        disabled={disabled}
                        tone="success"
                        onClick={() => onAction('stage')}
                    />
                </>
            )}
        </div>
    );
});

interface FileDiffActionButtonProps {
    label: string;
    icon: 'add' | 'arrow-go-back';
    loading: boolean;
    disabled: boolean;
    tone?: 'failure' | 'success';
    onClick: () => void;
}

const FileDiffActionButton: React.FC<FileDiffActionButtonProps> = ({
    label,
    icon,
    loading,
    disabled,
    tone,
    onClick,
}) => (
    <Button
        variant="ghost"
        size="sm"
        className={cn(
            'h-6 w-6 rounded-none bg-transparent p-0 text-muted-foreground opacity-70 hover:bg-transparent hover:text-foreground hover:opacity-100',
            tone === 'failure' && 'text-[var(--status-error)] hover:text-[var(--status-error)]',
            tone === 'success' && 'text-[var(--status-success)] hover:text-[var(--status-success)]'
        )}
        disabled={disabled}
        title={label}
        aria-label={label}
        onClick={(event) => {
            event.stopPropagation();
            onClick();
        }}
    >
        {loading ? (
            <Icon name="loader-4" className="size-3.5 animate-spin" />
        ) : (
            <Icon name={icon} className={icon === 'add' ? 'size-4' : 'size-3.5'} />
        )}
    </Button>
);

interface MultiFileDiffEntryProps {
    directory: string;
    file: FileEntry;
    layout: 'inline' | 'side-by-side';
    wrapLines: boolean;
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
    /** Hide stage/unstage/revert actions (read-only scopes like branch diffs). */
    readOnlyActions?: boolean;
}

const MultiFileDiffEntry = React.memo<MultiFileDiffEntryProps>(({
    directory,
    file,
    layout,
    wrapLines,
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
    loadFullFiles = false,
    initialDiffData = null,
    readOnlyActions = false,
}) => {
    const { t } = useI18n();
    const { git } = useRuntimeAPIs();
    const cachedDiff = useGitStore(
        React.useCallback((state) => {
            return state.directories.get(directory)?.diffCache.get(file.path) ?? null;
        }, [directory, file.path])
    );
    const setDiff = useGitStore((state) => state.setDiff);
    const fetchStatus = useGitStore((state) => state.fetchStatus);
    const setDiffFileLayout = useUIStore((state) => state.setDiffFileLayout);

    const [diffRetryNonce, setDiffRetryNonce] = React.useState(0);
    const [diffLoadError, setDiffLoadError] = React.useState<string | null>(null);
    const [isLoading, setIsLoading] = React.useState(false);
    const [fileAction, setFileAction] = React.useState<FileDiffAction | null>(null);
    const [forceRenderLarge, setForceRenderLarge] = React.useState(false);
    const [localDiffData, setLocalDiffData] = React.useState<DiffData | null>(null);
    const [stagedDiffData, setStagedDiffData] = React.useState<DiffData | null>(null);
    const lastDiffRequestRef = React.useRef<string | null>(null);
    const sectionRef = React.useRef<HTMLDivElement | null>(null);

    const descriptor = React.useMemo(() => describeChange(file), [file]);
    const renderSideBySide = layout === 'side-by-side';
    const desiredContextMode: DiffContextMode = loadFullFiles ? 'full' : 'patch';
    const fileStatusKey = `${file.index}:${file.working_dir}:${file.insertions}:${file.deletions}`;

    const diffData = React.useMemo<DiffData | null>(() => {
        if (initialDiffData) return initialDiffData;
        if (staged) return stagedDiffData;
        if (localDiffData) return localDiffData;
        if (!cachedDiff) return null;
        return { original: cachedDiff.original, modified: cachedDiff.modified, isBinary: cachedDiff.isBinary, contextMode: 'full' };
    }, [cachedDiff, initialDiffData, localDiffData, staged, stagedDiffData]);

    const diffDataMatchesContextMode = diffData?.contextMode === desiredContextMode;

    const setSectionRef = React.useCallback((node: HTMLDivElement | null) => {
        sectionRef.current = node;
        registerSectionRef(file.path, node);
    }, [file.path, registerSectionRef]);

    const handleOpenChange = React.useCallback((open: boolean) => {
        onExpandedChange(file.path, open);
    }, [file.path, onExpandedChange]);

    const handleSelect = React.useCallback(() => {
        onSelect(file.path);
    }, [file.path, onSelect]);

    React.useEffect(() => {
        if (!staged) {
            setLocalDiffData(null);
        } else {
            setStagedDiffData(null);
        }

        setDiffLoadError(null);
        lastDiffRequestRef.current = null;
    }, [fileStatusKey, staged]);

    React.useEffect(() => {
        if (!isExpanded || !isMounted) return;
        if (!directory || initialDiffData || (diffData && diffDataMatchesContextMode)) {
            lastDiffRequestRef.current = null;
            setIsLoading(false);
            return;
        }

        const requestKey = `${directory}::${file.path}::${staged ? 'staged' : 'unstaged'}::${fileStatusKey}::${desiredContextMode}::${diffRetryNonce}`;
        if (lastDiffRequestRef.current === requestKey) {
            return;
        }
        lastDiffRequestRef.current = requestKey;
        setDiffLoadError(null);
        setIsLoading(true);

        let cancelled = false;
        const runtimeKey = getRuntimeKey();
        const contextLines = loadFullFiles ? FULL_CONTEXT_DIFF_LINES : DEFAULT_CONTEXT_DIFF_LINES;
        const fetchPromise = isImageFile(file.path)
            ? git.getGitFileDiff(directory, { path: file.path, staged })
            : git.getGitDiff(directory, { path: file.path, staged, contextLines });
        const timeoutMs = DIFF_REQUEST_TIMEOUT_MS;
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
        });

        void Promise.race([fetchPromise, timeoutPromise])
            .then((response) => {
                if (cancelled) return;

                if ('diff' in response) {
                    const nextDiff = createTextDiffDataFromPatch(file.path, response.diff, desiredContextMode);
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
                        contextMode: 'full' as const,
                    };
                    if (staged) {
                        setStagedDiffData(nextDiff);
                    } else {
                        setDiff(directory, file.path, nextDiff, runtimeKey);
                    }
                }
                setIsLoading(false);
            })
            .catch((error) => {
                if (cancelled) return;
                const message = error instanceof Error ? error.message : String(error);
                setDiffLoadError(message);
                setIsLoading(false);
            });

        return () => {
            cancelled = true;
            if (lastDiffRequestRef.current === requestKey) {
                lastDiffRequestRef.current = null;
            }
        };
    }, [desiredContextMode, diffData, diffDataMatchesContextMode, diffRetryNonce, directory, file.path, fileStatusKey, git, initialDiffData, isExpanded, isMounted, loadFullFiles, setDiff, staged]);

    const handleToggle = React.useCallback(() => {
        handleOpenChange(!isExpanded);
        handleSelect();
    }, [handleOpenChange, handleSelect, isExpanded]);

    const handleFileAction = React.useCallback(async (action: FileDiffAction) => {
        if (!directory || fileAction !== null) {
            return;
        }

        setFileAction(action);
        try {
            if (action === 'stage') {
                await git.stageGitFile(directory, file.path);
            } else if (action === 'unstage') {
                await git.unstageGitFile(directory, file.path);
            } else {
                await git.revertGitFile(directory, file.path, { scope: 'working' });
            }
            setDiffRetryNonce((nonce) => nonce + 1);
            await fetchStatus(directory, git);
        } catch (error) {
            const fallbackKey = action === 'unstage'
                ? 'gitView.toast.unstageFileFailed'
                : action === 'stage'
                    ? 'gitView.toast.stageFileFailed'
                    : 'gitView.toast.revertFailed';
            toast.error(error instanceof Error ? error.message : t(fallbackKey));
        } finally {
            setFileAction((current) => (current === action ? null : current));
        }
    }, [directory, fetchStatus, file.path, fileAction, git, t]);

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
                                                className="block min-w-0 truncate typography-ui-label text-foreground"
                                                style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
                                            >
                                                {file.path}
                                            </span>
                                        );
                                    }

                                    const dir = file.path.slice(0, lastSlash);
                                    const name = file.path.slice(lastSlash + 1);

                                    return (
                                        <span className="flex min-w-0 items-baseline overflow-hidden">
                                            <span
                                                className="min-w-0 truncate typography-ui-label text-muted-foreground"
                                                style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
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
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-5 w-5 p-0 opacity-70 hover:opacity-100"
                                title={t('diffView.actions.openFileInEditorAtChange')}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onOpenInEditor(file.path, diffData);
                                }}
                                disabled={isOpeningInEditor}
                            >
                                {isOpeningInEditor ? (
                                    <Icon name="loader-4" className="size-3.5 animate-spin" />
                                ) : (
                                    <Icon name="edit" className="size-3.5" />
                                )}
                            </Button>
                        ) : null}
                        <DiffViewToggle
                            mode={renderSideBySide ? 'side-by-side' : 'unified'}
                            onModeChange={(mode: DiffViewMode) => {
                                const nextLayout: 'inline' | 'side-by-side' =
                                    mode === 'side-by-side' ? 'side-by-side' : 'inline';
                                setDiffFileLayout(file.path, nextLayout);
                            }}
                            className="opacity-70"
                        />
                    </div>
                </div>
            </div>
            {isExpanded && (
                <div className="relative bg-background overflow-hidden">
                    {!isMounted && !diffLoadError ? (
                        <div className="h-40 border border-border/40 bg-background/40" />
                    ) : null}
                    {diffLoadError ? (
                        <div className="flex flex-col items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
                            <div className="typography-ui-label font-semibold text-foreground">
                                {t('diffView.state.failedToLoadDiff')}
                            </div>
                            <div className="typography-meta text-muted-foreground max-w-[32rem] text-center">
                                {diffLoadError}
                            </div>
                            <button
                                type="button"
                                className="typography-ui-label text-primary hover:underline"
                                onClick={() => setDiffRetryNonce((nonce) => nonce + 1)}
                            >
                                {t('diffView.actions.retry')}
                            </button>
                        </div>
                    ) : null}
                    {isMounted && isLoading && !diffData && !diffLoadError ? (
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
                                renderSideBySide={renderSideBySide}
                                wrapLines={wrapLines}
                            />
                            <div className="pointer-events-none absolute bottom-3 right-3 z-20">
                                <div className="pointer-events-auto">
                                    {!readOnlyActions ? (
                                        <FileDiffActions
                                            filePath={file.path}
                                            staged={staged}
                                            busyAction={fileAction}
                                            disabled={fileAction !== null}
                                            onAction={handleFileAction}
                                        />
                                    ) : null}
                                </div>
                            </div>
                        </>
                    ) : null}
                </div>
            )}
        </div>
    );
});

interface DiffViewProps {
    hideStackedFileSidebar?: boolean;
    stackedDefaultCollapsedAll?: boolean;
    pinSelectedFileHeaderToTopOnNavigate?: boolean;
    showOpenInEditorAction?: boolean;
    diffScope?: DiffScope;
    onDiffScopeChange?: (scope: Extract<DiffScope, 'working' | 'staged' | 'turn' | 'branch'>) => void;
    targetFilePath?: string | null;
    /** Render diff content flush with the container edges (no outer padding). */
    flushContent?: boolean;
}

export const DiffView: React.FC<DiffViewProps> = ({
    hideStackedFileSidebar = false,
    stackedDefaultCollapsedAll = false,
    pinSelectedFileHeaderToTopOnNavigate = false,
    showOpenInEditorAction = false,
    diffScope = 'all',
    onDiffScopeChange,
    targetFilePath = null,
    flushContent = false,
}) => {
    const { t } = useI18n();
    const { git, files } = useRuntimeAPIs();
    const effectiveDirectory = useEffectiveDirectory();
    const openContextSurface = useUIStore((state) => state.openContextSurface);
    const requestWalkthroughSource = useWalkthroughStore((state) => state.requestSource);
    const { screenWidth, isMobile } = useDeviceInfo();

    const isGitRepo = useIsGitRepo(effectiveDirectory ?? null);
    const status = useGitStatus(effectiveDirectory ?? null);
    const isLoadingStatus = useGitLoadingStatus(effectiveDirectory ?? null);
    const setActiveDirectory = useGitStore((state) => state.setActiveDirectory);
    const ensureStatus = useGitStore((state) => state.ensureStatus);
    const fetchStatus = useGitStore((state) => state.fetchStatus);
    const fetchBranches = useGitStore((state) => state.fetchBranches);
    const clearDiffCache = useGitStore((state) => state.clearDiffCache);
    const setDiff = useGitStore((state) => state.setDiff);
    const [displayFile, setDisplayFile] = React.useState<string | null>(null);
    const [displayFileStaged, setDisplayFileStaged] = React.useState(false);
    const [pinnedStackedTarget, setPinnedStackedTarget] = React.useState<string | null>(null);
    const [expandedFiles, setExpandedFiles] = React.useState<Set<string>>(() => new Set());
    const [mountedStackedFiles, setMountedStackedFiles] = React.useState<Set<string>>(() => new Set());
    const [loadFullFiles, setLoadFullFiles] = React.useState(false);
    const [scrollRequestNonce, setScrollRequestNonce] = React.useState(0);
    const [fileDiffRefreshNonce, setFileDiffRefreshNonce] = React.useState<Map<string, number>>(() => new Map());
    const [reviewDialogOpen, setReviewDialogOpen] = React.useState(false);
    const [reviewFlowSubmitting, setReviewFlowSubmitting] = React.useState(false);
    const [activeDiffScope, setActiveDiffScope] = React.useState(diffScope);

    React.useEffect(() => {
        setActiveDiffScope(diffScope);
    }, [diffScope]);

    const pendingDiffFile = useUIStore((state) => state.pendingDiffFile);
    const pendingDiffStaged = useUIStore((state) => state.pendingDiffStaged);
    const pendingDiffScope = useUIStore((state) => state.pendingDiffScope);
    const setPendingDiffFile = useUIStore((state) => state.setPendingDiffFile);
    const diffLayoutPreference = useUIStore((state) => state.diffLayoutPreference);
    const diffFileLayout = useUIStore((state) => state.diffFileLayout);
    const setDiffFileLayout = useUIStore((state) => state.setDiffFileLayout);
    const diffWrapLinesStore = useUIStore((state) => state.diffWrapLines);
    const setDiffWrapLines = useUIStore((state) => state.setDiffWrapLines);
    const openContextFileAtLine = useUIStore((state) => state.openContextFileAtLine);
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const sessionMessages = useSessionMessages(currentSessionId ?? '', effectiveDirectory ?? undefined);
    const diffWrapLines = diffWrapLinesStore;
    const forcedStaged = activeDiffScope === 'staged' ? true : activeDiffScope === 'working' ? false : null;
    const activeDiffStaged = forcedStaged ?? displayFileStaged;

    const isMobileLayout = isMobile || screenWidth <= 768;
    const showReviewAction = Boolean(currentSessionId) && activeDiffScope !== 'turn' && !isMobileLayout && !isVSCodeRuntime();
    // Same runtime and width rules as the rail surface: no point offering an
    // entry point to a surface that cannot open here.
    const showWalkthroughAction = activeDiffScope !== 'turn' && !isMobileLayout && !isVSCodeRuntime();
    const showFileSidebar = !hideStackedFileSidebar && !isMobileLayout && screenWidth >= 1024;
    const diffScrollRef = React.useRef<HTMLElement | null>(null);
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

    const lastTurnDiffs = React.useMemo(() => {
        for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
            const message = sessionMessages[index] as { role?: string; summary?: { diffs?: unknown } };
            if (message.role !== 'user') continue;
            return listTurnDiffs(message.summary?.diffs);
        }
        return [];
    }, [sessionMessages]);

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
        isGitRepo !== false,
        isLoadingBranches,
        Boolean(branches),
        startBranchMetadataFetch,
        BRANCH_METADATA_MAX_ATTEMPTS
    );

    const repositoryDefaultBranch = React.useMemo(() => {
        const trackingRemote = status?.tracking?.trim().split('/')[0];
        return (trackingRemote && branches?.defaultBranches?.[trackingRemote])
            ?? branches?.defaultBranches?.origin
            ?? null;
    }, [branches, status?.tracking]);
    // Offered only while the default branch is known and the current branch is
    // not it (an unknown default must not flash the option on a guess), and
    // only outside VS Code (the extension has no context diff panel).
    const showBranchOption = !isVSCodeRuntime() && isBranchScopeAvailable(currentBranch, repositoryDefaultBranch);
    // Coercion acts only on CONFIRMED unavailability: the runtime has no branch
    // scope at all, a settled status has no branch (detached HEAD), the default
    // branch is known and we are on it, or metadata retries were exhausted.
    // While status/metadata are still loading a persisted branch scope must
    // survive instead of being rewritten to working on the first render.
    // `status !== null` is the settled test: before the first status request
    // even starts, status is null with loading still false, and that must not
    // read as "settled without a branch".
    const isBranchStatusResolved = status !== null;
    const branchScopeDefinitelyUnavailable = isVSCodeRuntime()
        || branchMetadataExhausted
        || isBranchScopeDefinitelyUnavailable(
            currentBranch,
            repositoryDefaultBranch,
            isBranchStatusResolved,
            branches !== null
        );

    const setBaseOverride = useGitBaseBranchStore((state) => state.setOverride);
    // Subscribe to the overrides map directly: `getOverride` reads `get()`
    // imperatively, so a memo over it never recomputes when the store changes
    // and a freshly picked base would be invisible until an unrelated rerender.
    // The key includes the current branch: a base picked for one feature branch
    // is not an answer for another branch of the same repository.
    const baseOverride = useGitBaseBranchStore(
        React.useCallback(
            (state) => (effectiveDirectory && currentBranch
                ? state.overrides[gitBaseBranchEntryKey(effectiveDirectory, currentBranch)] ?? null
                : null),
            [currentBranch, effectiveDirectory]
        )
    );
    const [detectedBranchBase, setDetectedBranchBase] = React.useState<string | null>(null);
    const [isBranchBaseResolved, setIsBranchBaseResolved] = React.useState(false);
    const [basePickerSearch, setBasePickerSearch] = React.useState('');

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
            // value always fits the callback domain.
            if (coercedScope === 'working') {
                onDiffScopeChange?.('working');
            }
        }
    }, [activeDiffScope, branchScopeDefinitelyUnavailable, onDiffScopeChange]);

    React.useEffect(() => {
        if (!showBranchOption || !effectiveDirectory || !currentBranch) {
            setDetectedBranchBase(null);
            setIsBranchBaseResolved(false);
            return;
        }

        let cancelled = false;
        setIsBranchBaseResolved(false);
        getBranchBase(effectiveDirectory, currentBranch)
            .then((result) => {
                if (!cancelled) setDetectedBranchBase(result.base);
            })
            .catch(() => {
                if (!cancelled) setDetectedBranchBase(null);
            })
            .finally(() => {
                if (!cancelled) setIsBranchBaseResolved(true);
            });
        return () => {
            cancelled = true;
        };
    }, [currentBranch, effectiveDirectory, showBranchOption]);

    // Explicit user choice outranks the detected source; both are real answers
    // from git or the user — never a main/master guess.
    const branchBase = baseOverride ?? detectedBranchBase;

    const [branchFiles, setBranchFiles] = React.useState<GitRangeFileEntry[] | null>(null);
    const [branchFilesError, setBranchFilesError] = React.useState<string | null>(null);

    // Shared by the scope/base effect and the error-state Retry button; the
    // fetch id discards completions from a superseded run (base or head
    // changed, or an earlier retry is still in flight).
    const branchFilesFetchIdRef = React.useRef(0);
    const reloadBranchFiles = React.useCallback(() => {
        if (!effectiveDirectory || !currentBranch || !branchBase) return;
        const fetchId = branchFilesFetchIdRef.current + 1;
        branchFilesFetchIdRef.current = fetchId;
        setBranchFiles(null);
        setBranchFilesError(null);
        getGitRangeFiles(effectiveDirectory, { base: branchBase, head: currentBranch })
            .then((files) => {
                if (branchFilesFetchIdRef.current === fetchId) setBranchFiles(files);
            })
            .catch((error) => {
                if (branchFilesFetchIdRef.current === fetchId) {
                    setBranchFilesError(error instanceof Error ? error.message : t('diffView.branch.loadError'));
                }
            });
    }, [branchBase, currentBranch, effectiveDirectory, t]);

    React.useEffect(() => {
        if (activeDiffScope === 'branch') {
            reloadBranchFiles();
        }
    }, [activeDiffScope, reloadBranchFiles]);

    // Range diffs are fetched per expanded file: unlike working/staged diffs
    // there is no per-file cache channel, so patch data lives in a range-keyed
    // local cache. Stale completions from a previous range cannot write into
    // the new range's cache (see useRangeKeyedCache).
    const branchDiffRangeKey = activeDiffScope === 'branch' && effectiveDirectory && currentBranch && branchBase
        ? branchRangeKey(effectiveDirectory, branchBase, currentBranch)
        : null;
    const branchDiffPathsKey = React.useMemo(
        () => (activeDiffScope === 'branch' ? Array.from(expandedFiles).sort().join('\0') : ''),
        [activeDiffScope, expandedFiles]
    );

    const fetchBranchDiffEntry = React.useCallback(
        (filePath: string) => {
            if (!effectiveDirectory || !branchBase || !currentBranch) {
                return Promise.reject(new Error('branch range is unavailable'));
            }
            return getGitRangeDiff(effectiveDirectory, { base: branchBase, head: currentBranch, path: filePath })
                .then((response) => createTextDiffDataFromPatch(filePath, response.diff, 'patch'));
        },
        [branchBase, currentBranch, effectiveDirectory]
    );

    const branchDiffData = useRangeKeyedCache<DiffData>(
        branchDiffRangeKey,
        branchDiffPathsKey,
        branchDiffRangeKey ? fetchBranchDiffEntry : null,
        EMPTY_BRANCH_DIFF_PLACEHOLDER
    );

    const branchFileCount = branchFiles?.length ?? null;

    const changedFiles: FileEntry[] = React.useMemo(() => {
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
        const diffStats = status.diffStats ?? {};
        const includeFile = activeDiffScope === 'staged'
            ? isStagedStatusFile
            : activeDiffScope === 'working'
                ? isWorkingStatusFile
                : () => true;

        return status.files
            .filter(includeFile)
            .map((file) => ({
                ...file,
                insertions: diffStats[file.path]?.insertions ?? 0,
                deletions: diffStats[file.path]?.deletions ?? 0,
                isNew: isNewStatusFile(file),
            }))
            .sort((a, b) => a.path.localeCompare(b.path));
    }, [activeDiffScope, branchFiles, lastTurnDiffs, status]);

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
    }, [expandedFiles]);

    const queueVisibleStackedFilesSync = React.useCallback(() => {
        if (typeof window === 'undefined') return;
        if (visibleSyncFrameRef.current !== null) return;
        visibleSyncFrameRef.current = window.requestAnimationFrame(syncVisibleStackedFiles);
    }, [syncVisibleStackedFiles]);

    React.useEffect(() => {
        const scrollRoot = diffScrollRef.current;
        if (!scrollRoot) return;

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
    }, [changedFiles, expandedFiles, queueVisibleStackedFilesSync]);

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
        if (effectiveDirectory) {
            setActiveDirectory(effectiveDirectory);
            void ensureStatus(effectiveDirectory, git);
        }
    }, [effectiveDirectory, setActiveDirectory, ensureStatus, git]);

    React.useEffect(() => {
        if (!effectiveDirectory) {
            return;
        }

        return sessionEvents.onGitRefreshHint((hint) => {
            if (normalizePath(hint.directory) !== normalizePath(effectiveDirectory)) {
                return;
            }
            if (hint.paths?.length) {
                pendingScrollAnchorRestoreRef.current = captureScrollAnchor() ?? lastScrollAnchorRef.current;
                clearDiffCache(effectiveDirectory, hint.paths);
                setFileDiffRefreshNonce((previous) => {
                    const next = new Map(previous);
                    for (const path of hint.paths ?? []) {
                        next.set(path, (next.get(path) ?? 0) + 1);
                    }
                    return next;
                });
            }
            void fetchStatus(effectiveDirectory, git, { silent: true });
        });
    }, [captureScrollAnchor, clearDiffCache, effectiveDirectory, fetchStatus, git]);

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
        if (activeDiffScope !== 'all' && !pendingDiffScope) {
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
    }, [activeDiffScope, expandStackedFile, pendingDiffFile, pendingDiffScope, pendingDiffStaged, setPendingDiffFile]);

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
        queueVisibleStackedFilesSync();
    }, [queueVisibleStackedFilesSync]);

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
        queueVisibleStackedFilesSync();
    }, [cancelPendingScrollAlignment, queueVisibleStackedFilesSync]);

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

    const handleStartReviewFlow = React.useCallback(async (execution: ReviewFlowExecution) => {
        if (!currentSessionId) return;
        const directory = useSessionUIStore.getState().getDirectoryForSession(currentSessionId) || effectiveDirectory || '';
        if (!directory) {
            toast.error(t('diffView.reviewDialog.toast.noSessionDirectory'));
            return;
        }

        setReviewFlowSubmitting(true);
        try {
            await startReviewFlow({
                originalSessionID: currentSessionId,
                directory,
                providerID: execution.providerID,
                modelID: execution.modelID,
                agent: execution.agent || undefined,
                variant: execution.variant || undefined,
                generateHandoff: execution.generateHandoff,
                returnAfterHandoffRequest: execution.generateHandoff,
                autoReview: execution.autoReview,
            });
            setReviewDialogOpen(false);
        } catch (error) {
            console.error('[review-flow] failed to start review flow', error);
            toast.error(error instanceof Error ? error.message : t('diffView.reviewDialog.toast.startFailed'));
        } finally {
            setReviewFlowSubmitting(false);
        }
    }, [currentSessionId, effectiveDirectory, t]);

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

    React.useEffect(() => {
        const target = pendingScrollTargetRef.current;
        if (!target) return;

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
    }, [pinSelectedFileHeaderToTopOnNavigate, scrollRequestNonce, scrollToFile]);

    const handleSelectFile = React.useCallback((value: string) => {
        void value;
    }, []);

    const handleSelectFileAndScroll = React.useCallback((value: string) => {
        cancelPendingScrollAlignment();

        setDisplayFile(value);
        setDisplayFileStaged(false);
        shouldPinAfterAlignRef.current = true;
        pendingScrollTargetRef.current = value;
        expandStackedFile(value);
        setScrollRequestNonce((nonce) => nonce + 1);
        scrollToFile(value);
    }, [cancelPendingScrollAlignment, expandStackedFile, scrollToFile]);

    const handleHeaderLayoutChange = React.useCallback((mode: DiffViewMode) => {
        const nextLayout: 'inline' | 'side-by-side' =
            mode === 'side-by-side' ? 'side-by-side' : 'inline';

        changedFiles.forEach((file) => {
            setDiffFileLayout(file.path, nextLayout);
        });
    }, [changedFiles, setDiffFileLayout]);

    const [openingEditorFilePath, setOpeningEditorFilePath] = React.useState<string | null>(null);

    const openFileInEditorAtChange = React.useCallback(async (filePath: string, cachedDiffData: DiffData | null) => {
        if (!effectiveDirectory || !filePath) {
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
                diffForNavigation = {
                    original: response.original ?? '',
                    modified: response.modified ?? '',
                    isBinary: response.isBinary,
                };
                if (!activeDiffStaged) {
                    setDiff(effectiveDirectory, filePath, diffForNavigation, runtimeKey);
                }
            }

            const resolvedTargetLine = targetLine ?? ((diffForNavigation.isBinary || isImageFile(filePath))
                ? 1
                : getFirstChangedModifiedLine(diffForNavigation.original, diffForNavigation.modified));

            const absolutePath = toAbsolutePath(effectiveDirectory, filePath);
            const openValidation = await validateContextFileOpen(files, absolutePath, { directory: effectiveDirectory });
            if (!openValidation.ok) {
                toast.error(getContextFileOpenFailureMessage(openValidation.reason));
                return;
            }

            openContextFileAtLine(
                effectiveDirectory,
                absolutePath,
                resolvedTargetLine,
                1,
            );
        } finally {
            setOpeningEditorFilePath((current) => (current === filePath ? null : current));
        }
    }, [activeDiffStaged, effectiveDirectory, files, git, openContextFileAtLine, setDiff]);

    const renderStackedDiffView = () => {
        if (!effectiveDirectory) return null;

        const getFileStaged = (path: string) => {
            if (forcedStaged !== null) {
                return forcedStaged;
            }
            return displayFileStaged && path === displayFile;
        };

        return (
            <div className={cn('flex min-w-0 flex-1 min-h-0 h-full', flushContent ? 'gap-0' : 'gap-3 px-3 pb-3 pt-2')}>
                {showFileSidebar && (
                    <section className="hidden lg:flex w-72 flex-col rounded-xl border border-border/60 bg-background/70 overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40">
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
                    <ScrollableOverlay
                        ref={diffScrollRef}
                        outerClassName="min-h-0 h-full"
                        className="[overflow-anchor:none] pb-16"
                        disableHorizontal
                        observeMutations={false}
                        preventOverscroll
                        data-diff-virtual-root
                    >
                        <div className="flex flex-col [overflow-anchor:none]" data-diff-virtual-content>
                            {changedFiles.map((file) => (
                                <MultiFileDiffEntry
                                    key={`${file.path}:${fileDiffRefreshNonce.get(file.path) ?? 0}`}
                                    directory={effectiveDirectory}
                                    file={file}
                                    layout={getLayoutForFile(file)}
                                    wrapLines={diffWrapLines}
                                    isSelected={false}
                                    isExpanded={expandedFiles.has(file.path)}
                                    isMounted={mountedStackedFiles.has(file.path) || file.path === pinnedStackedTarget}
                                    onSelect={handleSelectFile}
                                    onExpandedChange={handleStackedEntryExpandedChange}
                                    registerSectionRef={registerSectionRef}
                                    showOpenInEditorAction={showOpenInEditorAction && activeDiffScope !== 'turn'}
                                    isOpeningInEditor={openingEditorFilePath === file.path}
                                    onOpenInEditor={(filePath, diffData) => {
                                        void openFileInEditorAtChange(filePath, diffData);
                                    }}
                                    staged={getFileStaged(file.path)}
                                    loadFullFiles={loadFullFiles}
                                    readOnlyActions={activeDiffScope === 'branch'}
                                    initialDiffData={
                                        activeDiffScope === 'turn'
                                            ? lastTurnDiffData.get(file.path) ?? null
                                            : activeDiffScope === 'branch'
                                                ? branchDiffData.get(file.path) ?? null
                                                : null
                                    }
                                />
                            ))}
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

        if (activeDiffScope === 'branch') {
            if (!isBranchBaseResolved) {
                return (
                    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                        <Icon name="loader-4" className="size-4 animate-spin" />
                        {t('diffView.branch.resolvingBase')}
                    </div>
                );
            }

            if (!branchBase) {
                const searchTerm = basePickerSearch.trim().toLowerCase();
                const candidateBranches = (branches?.all ?? [])
                    .map((name: string) => name.replace(/^remotes\//, ''))
                    .filter((name: string) => name !== currentBranch && !name.endsWith(`/${currentBranch}`))
                    .filter((name: string) => !searchTerm || name.toLowerCase().includes(searchTerm))
                    .sort();
                return (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                        <Icon name="git-branch" className="size-6 text-muted-foreground" />
                        <div className="typography-ui-label font-semibold text-foreground">{t('diffView.branch.noBaseTitle')}</div>
                        <div className="max-w-sm typography-micro text-muted-foreground">{t('diffView.branch.noBaseDescription')}</div>
                        <input
                            type="text"
                            value={basePickerSearch}
                            onChange={(event) => setBasePickerSearch(event.target.value)}
                            placeholder={t('gitView.branch.searchPlaceholder')}
                            aria-label={t('gitView.branch.searchPlaceholder')}
                            className="w-full max-w-sm rounded-md border border-border/60 bg-[var(--surface-elevated)] px-2.5 py-1.5 typography-meta text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
                        />
                        <ScrollableOverlay outerClassName="max-h-48 w-full max-w-sm min-h-0" className="px-1 py-1">
                            {candidateBranches.length === 0 ? (
                                <div className="px-2 py-3 typography-meta text-muted-foreground">
                                    {t('gitView.branch.empty')}
                                </div>
                            ) : (
                                <div className="flex flex-col gap-0.5">
                                    {candidateBranches.map((branch: string) => (
                                        <button
                                            key={branch}
                                            type="button"
                                            onClick={() => effectiveDirectory && currentBranch && setBaseOverride(effectiveDirectory, currentBranch, branch)}
                                            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
                                        >
                                            <Icon name="git-branch" className="size-3.5 text-primary" />
                                            <span className="truncate typography-ui-label text-foreground" title={branch}>{branch}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </ScrollableOverlay>
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
                            onClick={() => reloadBranchFiles()}
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

        if (changedFiles.length === 0) {
            return (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {activeDiffScope === 'turn' ? t('diffView.state.noLastTurnChanges')
                        : activeDiffScope === 'branch' && branchBase ? t('diffView.branch.empty', { base: branchBase })
                        : t('diffView.state.cleanWorkingTree')}
                </div>
            );
        }

        return renderStackedDiffView();
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background">
            <div className="@container/diff-toolbar flex min-w-0 items-center gap-2 px-3 py-2 bg-background">
                {!isMobile && (
                    activeDiffScope === 'working' || activeDiffScope === 'staged' || activeDiffScope === 'turn' || activeDiffScope === 'branch' ? (
                        <ChangeScopeSelector
                            scope={activeDiffScope}
                            workingCount={workingFileCount}
                            stagedCount={stagedFileCount}
                            turnCount={turnFileCount}
                            branchCount={branchFileCount}
                            showBranchOption={showBranchOption}
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
                {changedFiles.length > 0 && (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleExpandOrCollapseAll}
                        className={cn(
                            'diff-toolbar__expand-button h-7 flex-shrink-0 gap-1 px-1.5 text-muted-foreground hover:text-foreground',
                            'ml-auto',
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
                {changedFiles.length > 0 && showWalkthroughAction && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            // Carry the scope across: opening the walkthrough
                            // while looking at staged changes should review
                            // staged changes, not whatever the panel showed last.
                            const directory = effectiveDirectory ?? '';
                            requestWalkthroughSource(directory, {
                                kind: 'working-tree',
                                scope: activeDiffScope === 'staged' || activeDiffScope === 'working'
                                    ? activeDiffScope
                                    : 'all',
                            });
                            openContextSurface(directory, 'walkthrough');
                        }}
                        className={cn('diff-toolbar__walkthrough-button h-7 flex-shrink-0 gap-1.5 px-2', WALKTHROUGH_ACTION_CLASS)}
                        aria-label={t('walkthrough.action.open')}
                    >
                        <Icon name="route" className="size-4" />
                        <span className="diff-toolbar__walkthrough-label typography-ui-label">
                            {t('walkthrough.action.open')}
                        </span>
                    </Button>
                )}
                {changedFiles.length > 0 && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setLoadFullFiles((value) => !value)}
                                aria-pressed={loadFullFiles}
                                aria-label={loadFullFiles ? t('diffView.actions.disableFullFiles') : t('diffView.actions.loadFullFiles')}
                                className={cn(
                                    'h-7 w-7 flex-shrink-0 p-0 text-muted-foreground hover:text-foreground',
                                    loadFullFiles && 'bg-interactive-selection text-interactive-selection-foreground',
                                )}
                            >
                                <Icon name="file-download" className="size-4" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            <p>{loadFullFiles ? t('diffView.actions.disableFullFiles') : t('diffView.actions.loadFullFiles')}</p>
                        </TooltipContent>
                    </Tooltip>
                )}
                {changedFiles.length > 0 && (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDiffWrapLines(!diffWrapLinesStore)}
                        className={cn(
                            'h-5 w-5 p-0 transition-opacity',
                            diffWrapLines ? 'text-foreground opacity-100' : 'text-muted-foreground opacity-60 hover:opacity-100'
                        )}
                        title={diffWrapLines ? t('diffView.actions.disableLineWrap') : t('diffView.actions.enableLineWrap')}
                    >
                        <Icon name="text-wrap" className="size-4" />
                    </Button>
                )}
                {currentLayoutForAllFiles && (
                    <DiffViewToggle
                        mode={currentLayoutForAllFiles === 'side-by-side' ? 'side-by-side' : 'unified'}
                        onModeChange={handleHeaderLayoutChange}
                    />
                )}
            </div>

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
