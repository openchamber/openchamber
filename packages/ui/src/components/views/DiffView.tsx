import React from 'react';

import { useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useGitStore, useGitStatus, useIsGitRepo, useGitLoadingStatus } from '@/stores/useGitStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import type { GitStatus } from '@/lib/api/types';
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
import { useI18n } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n/store';
import { fileDiffFromPatch } from '@/lib/diff/patchFileDiff';
import { isVSCodeRuntime } from '@/lib/desktop';
import { startReviewFlow } from '@/lib/reviewFlow';
import { opencodeClient } from '@/lib/opencode/client';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectorySync, useSessionMessages, useSessionStatus } from '@/sync/sync-context';
import { getFirstChangedModifiedLineFromPatch } from './diffPatchUtils';
import { isBranchDiffAvailable, loadBranchDiff, mapBranchDiffEntries, shouldPrefetchBranchDiff } from './branchDiff';
import type { FileDiffMetadata } from '@pierre/diffs';
import type { VcsFileDiff } from '@opencode-ai/sdk/v2';

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
    readOnly?: boolean;
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
type DiffScope = 'all' | 'staged' | 'working' | 'branch' | 'turn';
type SelectableDiffScope = Exclude<DiffScope, 'all'>;

type TurnSnapshotDiff = {
    file?: string;
    status?: string;
    before?: string;
    after?: string;
    patch?: string;
    additions?: number;
    deletions?: number;
};

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
    scope: SelectableDiffScope;
    workingCount: number;
    stagedCount: number;
    branchCount: number | null;
    turnCount: number;
    branchAvailable: boolean;
    onScopeChange?: (scope: SelectableDiffScope) => void;
}

const ChangeScopeSelector = React.memo<ChangeScopeSelectorProps>(({
    scope,
    workingCount,
    stagedCount,
    branchCount,
    turnCount,
    branchAvailable,
    onScopeChange,
}) => {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(false);
    const currentCount = scope === 'staged'
        ? stagedCount
        : scope === 'branch'
            ? branchCount
            : scope === 'turn'
                ? turnCount
                : workingCount;
    const currentLabel = scope === 'staged'
        ? t('diffView.scope.staged')
        : scope === 'branch'
            ? t('diffView.scope.branch')
            : scope === 'turn'
                ? t('diffView.scope.lastTurn')
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
                        {currentLabel}{currentCount !== null ? <span className="diff-toolbar__scope-count">: {currentCount}</span> : null}
                    </span>
                    <Icon name="arrow-down-s" className="size-4 flex-shrink-0 opacity-60" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-40">
                <DropdownMenuRadioGroup
                    value={scope}
                    onValueChange={(value) => {
                        if (value === 'working' || value === 'staged' || value === 'branch' || value === 'turn') {
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
                    {branchAvailable ? (
                        <DropdownMenuRadioItem value="branch">
                            <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                <span>{t('diffView.scope.branch')}</span>
                                {branchCount !== null ? (
                                    <span className="typography-meta text-muted-foreground">{branchCount}</span>
                                ) : null}
                            </span>
                        </DropdownMenuRadioItem>
                    ) : null}
                    <DropdownMenuRadioItem value="turn">
                        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                            <span>{t('diffView.scope.lastTurn')}</span>
                            <span className="typography-meta text-muted-foreground">{turnCount}</span>
                        </span>
                    </DropdownMenuRadioItem>
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
        <div className="flex items-center gap-0.5 rounded-full border border-[var(--interactive-border)]/45 bg-[var(--surface-background)]/95 px-1 py-0.5 shadow-lg backdrop-blur-md">
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
    readOnly?: boolean;
    diffUnavailable?: boolean;
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
    readOnly = false,
    diffUnavailable = false,
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
        if (!directory || initialDiffData || diffUnavailable || (diffData && diffDataMatchesContextMode)) {
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
    }, [desiredContextMode, diffData, diffDataMatchesContextMode, diffRetryNonce, diffUnavailable, directory, file.path, fileStatusKey, git, initialDiffData, isExpanded, isMounted, loadFullFiles, setDiff, staged]);

    const handleToggle = React.useCallback(() => {
        handleOpenChange(!isExpanded);
        handleSelect();
    }, [handleOpenChange, handleSelect, isExpanded]);

    const handleFileAction = React.useCallback(async (action: FileDiffAction) => {
        if (readOnly || !directory || fileAction !== null) {
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
    }, [directory, fetchStatus, file.path, fileAction, git, readOnly, t]);

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
                    {isMounted && diffUnavailable && !diffData && !diffLoadError ? (
                        <div className="flex items-center justify-center px-4 py-8 text-sm text-muted-foreground">
                            {t('diffView.state.branchPatchUnavailable')}
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
                            {!readOnly ? (
                                <div className="pointer-events-none absolute bottom-3 right-3 z-20">
                                    <div className="pointer-events-auto">
                                        <FileDiffActions
                                            filePath={file.path}
                                            staged={staged}
                                            busyAction={fileAction}
                                            disabled={fileAction !== null}
                                            onAction={handleFileAction}
                                        />
                                    </div>
                                </div>
                            ) : null}
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
    onDiffScopeChange?: (scope: SelectableDiffScope) => void;
    targetFilePath?: string | null;
    isActive?: boolean;
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
    isActive = true,
    flushContent = false,
}) => {
    const { t } = useI18n();
    const { git, files } = useRuntimeAPIs();
    const effectiveDirectory = useEffectiveDirectory();
    const { screenWidth, isMobile } = useDeviceInfo();

    const isGitRepo = useIsGitRepo(effectiveDirectory ?? null);
    const status = useGitStatus(effectiveDirectory ?? null);
    const isLoadingStatus = useGitLoadingStatus(effectiveDirectory ?? null);
    const lastStatusFetch = useGitStore(React.useCallback(
        (state) => effectiveDirectory ? state.directories.get(effectiveDirectory)?.lastStatusFetch ?? 0 : 0,
        [effectiveDirectory],
    ));
    const setActiveDirectory = useGitStore((state) => state.setActiveDirectory);
    const ensureStatus = useGitStore((state) => state.ensureStatus);
    const fetchStatus = useGitStore((state) => state.fetchStatus);
    const setDiff = useGitStore((state) => state.setDiff);
    const [displayFile, setDisplayFile] = React.useState<string | null>(null);
    const [displayFileStaged, setDisplayFileStaged] = React.useState(false);
    const [pinnedStackedTarget, setPinnedStackedTarget] = React.useState<string | null>(null);
    const [expandedFiles, setExpandedFiles] = React.useState<Set<string>>(() => new Set());
    const [mountedStackedFiles, setMountedStackedFiles] = React.useState<Set<string>>(() => new Set());
    const [loadFullFiles, setLoadFullFiles] = React.useState(false);
    const [scrollRequestNonce, setScrollRequestNonce] = React.useState(0);
    const [reviewDialogOpen, setReviewDialogOpen] = React.useState(false);
    const [reviewFlowSubmitting, setReviewFlowSubmitting] = React.useState(false);
    const [activeDiffScope, setActiveDiffScope] = React.useState(diffScope);
    const [branchDiffState, setBranchDiffState] = React.useState<{
        key: string;
        data: VcsFileDiff[] | null;
        error: string | null;
        loading: boolean;
    }>({ key: '', data: null, error: null, loading: false });
    const [branchRefreshNonce, setBranchRefreshNonce] = React.useState(0);

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
    const sessionStatus = useSessionStatus(currentSessionId ?? '', effectiveDirectory ?? undefined);
    const vcsBranch = useDirectorySync((state) => state.vcs?.branch, effectiveDirectory ?? undefined);
    const vcsDefaultBranch = useDirectorySync((state) => state.vcs?.default_branch, effectiveDirectory ?? undefined);
    const vcsStatus = useDirectorySync((state) => state.vcs_status, effectiveDirectory ?? undefined);
    const diffWrapLines = diffWrapLinesStore;
    const forcedStaged = activeDiffScope === 'staged' ? true : activeDiffScope === 'working' ? false : null;
    const activeDiffStaged = forcedStaged ?? displayFileStaged;

    const isMobileLayout = isMobile || screenWidth <= 768;
    const showReviewAction = Boolean(currentSessionId) && activeDiffScope !== 'turn' && activeDiffScope !== 'branch' && !isMobileLayout && !isVSCodeRuntime();
    const showFileSidebar = !hideStackedFileSidebar && !isMobileLayout && screenWidth >= 1024;
    const diffScrollRef = React.useRef<HTMLElement | null>(null);
    const fileSectionRefs = React.useRef(new Map<string, HTMLDivElement | null>());
    const pendingScrollTargetRef = React.useRef<string | null>(null);
    const pendingScrollFrameRef = React.useRef<number | null>(null);
    const shouldPinAfterAlignRef = React.useRef(false);
    const visibleSyncFrameRef = React.useRef<number | null>(null);
    const stackedStateScopeRef = React.useRef<string | null>(null);
    const previousSessionStatusRef = React.useRef<{ sessionID: string | null; type?: string }>({ sessionID: null });
    const branchRequestQueueRef = React.useRef<Promise<void>>(Promise.resolve());

    const branchAvailable = isBranchDiffAvailable({
        branch: vcsBranch,
        default_branch: vcsDefaultBranch,
    });
    const branchStateKey = `${effectiveDirectory ?? ''}\0${vcsBranch ?? ''}\0${vcsDefaultBranch ?? ''}`;
    const branchDiffs = branchDiffState.key === branchStateKey ? branchDiffState.data : null;
    const branchDiffError = branchDiffState.key === branchStateKey ? branchDiffState.error : null;
    const shouldLoadBranchDiff = activeDiffScope === 'branch'
        || shouldPrefetchBranchDiff(branchDiffs, branchDiffError);
    const isLoadingBranchDiff = activeDiffScope === 'branch'
        && (branchDiffState.key !== branchStateKey || branchDiffState.loading);

    React.useEffect(() => {
        if (!isActive || activeDiffScope !== 'branch' || vcsStatus === 'loading' || branchAvailable) return;
        setActiveDiffScope('working');
        onDiffScopeChange?.('working');
    }, [activeDiffScope, branchAvailable, isActive, onDiffScopeChange, vcsStatus]);

    React.useEffect(() => {
        const nextType = sessionStatus?.type;
        const previous = previousSessionStatusRef.current;
        if (previous.sessionID !== currentSessionId) {
            previousSessionStatusRef.current = { sessionID: currentSessionId, type: nextType };
            return;
        }
        previousSessionStatusRef.current = { sessionID: currentSessionId, type: nextType };
        if (!isActive || activeDiffScope !== 'branch') return;
        if (nextType === 'idle' && previous.type && previous.type !== 'idle') {
            setBranchRefreshNonce((value) => value + 1);
        }
    }, [activeDiffScope, currentSessionId, isActive, sessionStatus?.type]);

    React.useEffect(() => {
        if (!isActive || !shouldLoadBranchDiff || !branchAvailable || !effectiveDirectory) return;

        let cancelled = false;
        let controller: AbortController | undefined;
        const timer = window.setTimeout(() => {
            branchRequestQueueRef.current = branchRequestQueueRef.current.catch(() => undefined).then(async () => {
                if (cancelled) return;
                setBranchDiffState((current) => ({
                    key: branchStateKey,
                    data: current.key === branchStateKey ? current.data : null,
                    error: null,
                    loading: true,
                }));

                const sdk = opencodeClient.getScopedSdkClient(effectiveDirectory);
                controller = new AbortController();
                let timeout: ReturnType<typeof setTimeout> | undefined;
                const timeoutPromise = new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => {
                        controller?.abort();
                        reject(new Error(`Timed out after ${DIFF_REQUEST_TIMEOUT_MS}ms`));
                    }, DIFF_REQUEST_TIMEOUT_MS);
                });

                try {
                    const data = await Promise.race([
                        loadBranchDiff(
                            (input, options) => sdk.vcs.diff(input, options),
                            effectiveDirectory,
                            controller.signal,
                        ),
                        timeoutPromise,
                    ]);
                    if (!cancelled) {
                        setBranchDiffState({ key: branchStateKey, data, error: null, loading: false });
                    }
                } catch (error) {
                    if (!cancelled) {
                        setBranchDiffState((current) => ({
                            key: branchStateKey,
                            data: current.key === branchStateKey ? current.data : null,
                            error: error instanceof Error ? error.message : String(error),
                            loading: false,
                        }));
                    }
                } finally {
                    if (timeout) clearTimeout(timeout);
                }
            });
        }, 120);

        return () => {
            cancelled = true;
            controller?.abort();
            window.clearTimeout(timer);
        };
    }, [branchAvailable, branchRefreshNonce, branchStateKey, effectiveDirectory, isActive, lastStatusFetch, shouldLoadBranchDiff]);

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

    const branchEntries = React.useMemo(
        () => mapBranchDiffEntries(branchDiffs ?? []),
        [branchDiffs],
    );

    const branchDiffData = React.useMemo(() => {
        const map = new Map<string, DiffData>();
        for (const entry of branchEntries) {
            if (!entry.patch) continue;
            map.set(entry.path, createTextDiffDataFromPatch(entry.path, entry.patch, 'patch'));
        }
        return map;
    }, [branchEntries]);

    const changedFiles: FileEntry[] = React.useMemo(() => {
        if (activeDiffScope === 'branch') {
            return branchEntries;
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
    }, [activeDiffScope, branchEntries, lastTurnDiffs, status]);

    const workingFileCount = React.useMemo(() => {
        if (!status?.files) return 0;
        return status.files.filter(isWorkingStatusFile).length;
    }, [status]);

    const stagedFileCount = React.useMemo(() => {
        if (!status?.files) return 0;
        return status.files.filter(isStagedStatusFile).length;
    }, [status]);

    const turnFileCount = lastTurnDiffs.length;
    const branchFileCount = branchDiffs ? branchEntries.length : null;

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

        for (const [path, node] of fileSectionRefs.current) {
            if (!node || !expandedFiles.has(path)) continue;
            const rect = node.getBoundingClientRect();
            if (rect.bottom < top || rect.top > bottom) continue;
            next[path] = true;
        }

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
        if (isActive && effectiveDirectory) {
            setActiveDirectory(effectiveDirectory);
            void ensureStatus(effectiveDirectory, git);
        }
    }, [effectiveDirectory, setActiveDirectory, ensureStatus, git, isActive]);

    React.useEffect(() => {
        if (!isActive || !effectiveDirectory) {
            return;
        }

        return sessionEvents.onGitRefreshHint((hint) => {
            if (normalizePath(hint.directory) !== normalizePath(effectiveDirectory)) {
                return;
            }
            void fetchStatus(effectiveDirectory, git);
        });
    }, [effectiveDirectory, fetchStatus, git, isActive]);

    React.useEffect(() => {
        if (!isActive || activeDiffScope !== 'branch' || !effectiveDirectory) return;
        return sessionEvents.onVcsDiffRefreshHint((hint) => {
            if (normalizePath(hint.directory) !== normalizePath(effectiveDirectory)) return;
            setBranchRefreshNonce((value) => value + 1);
        });
    }, [activeDiffScope, effectiveDirectory, isActive]);

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

        const rootRect = scrollRoot.getBoundingClientRect();
        const nodeRect = node.getBoundingClientRect();
        const delta = nodeRect.top - rootRect.top;
        const maxTop = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
        scrollRoot.scrollTop = Math.min(maxTop, Math.max(0, scrollRoot.scrollTop + delta));
        return true;
    }, []);

    React.useEffect(() => {
        const target = pendingScrollTargetRef.current;
        if (!target) return;

        let attempts = 0;
        const maxAttempts = 20;
        let cancelled = false;

        const cancelPending = () => {
            if (cancelled) {
                return;
            }
            cancelled = true;
            pendingScrollTargetRef.current = null;
            shouldPinAfterAlignRef.current = false;
            setPinnedStackedTarget(null);
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
    }, [changedFilePathsKey, pinSelectedFileHeaderToTopOnNavigate, scrollRequestNonce, scrollToFile]);

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
            if (activeDiffScope === 'branch') {
                const targetLine = cachedDiffData?.patch && !cachedDiffData.isBinary
                    ? getFirstChangedModifiedLineFromPatch(cachedDiffData.patch) ?? 1
                    : 1;
                const absolutePath = toAbsolutePath(effectiveDirectory, filePath);
                const openValidation = await validateContextFileOpen(files, absolutePath);
                if (!openValidation.ok) {
                    toast.error(getContextFileOpenFailureMessage(openValidation.reason));
                    return;
                }
                openContextFileAtLine(effectiveDirectory, absolutePath, targetLine, 1);
                return;
            }

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
            const openValidation = await validateContextFileOpen(files, absolutePath);
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
    }, [activeDiffScope, activeDiffStaged, effectiveDirectory, files, git, openContextFileAtLine, setDiff]);

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
                                    key={file.path}
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
                                    loadFullFiles={activeDiffScope === 'branch' ? false : loadFullFiles}
                                    initialDiffData={activeDiffScope === 'turn'
                                        ? lastTurnDiffData.get(file.path) ?? null
                                        : activeDiffScope === 'branch'
                                            ? branchDiffData.get(file.path) ?? null
                                            : null}
                                    readOnly={file.readOnly === true}
                                    diffUnavailable={activeDiffScope === 'branch' && !branchDiffData.has(file.path)}
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

        if (activeDiffScope === 'branch' && branchDiffError) {
            return (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-sm text-muted-foreground">
                    <div className="typography-ui-label font-semibold text-foreground">
                        {t('diffView.state.failedToLoadBranchChanges')}
                    </div>
                    <div className="typography-meta max-w-[32rem] text-center text-muted-foreground">
                        {branchDiffError}
                    </div>
                    <button
                        type="button"
                        className="typography-ui-label text-primary hover:underline"
                        onClick={() => setBranchRefreshNonce((value) => value + 1)}
                    >
                        {t('diffView.actions.retry')}
                    </button>
                </div>
            );
        }

        if (activeDiffScope === 'branch' && isLoadingBranchDiff && branchDiffs === null) {
            return (
                <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />
                    {t('diffView.state.loadingBranchChanges')}
                </div>
            );
        }

        if (activeDiffScope !== 'turn' && activeDiffScope !== 'branch' && isLoadingStatus && !status) {
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

        if (changedFiles.length === 0) {
            return (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {activeDiffScope === 'branch'
                        ? t('diffView.state.noBranchChanges')
                        : activeDiffScope === 'turn'
                            ? t('diffView.state.noLastTurnChanges')
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
                    activeDiffScope === 'working' || activeDiffScope === 'staged' || activeDiffScope === 'branch' || activeDiffScope === 'turn' ? (
                        <ChangeScopeSelector
                            scope={activeDiffScope}
                            workingCount={workingFileCount}
                            stagedCount={stagedFileCount}
                            branchCount={branchFileCount}
                            turnCount={turnFileCount}
                            branchAvailable={branchAvailable}
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
                {changedFiles.length > 0 && activeDiffScope !== 'branch' && (
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
