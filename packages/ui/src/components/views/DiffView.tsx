import React from 'react';
import { RiArrowDownSLine, RiArrowRightSLine, RiGitCommitLine, RiLoader4Line, RiTextWrap } from '@remixicon/react';

import { useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useGitStore, useGitStatus, useIsGitRepo, useGitFileCount } from '@/stores/useGitStore';
import { cn } from '@/lib/utils';
import type { GitStatus } from '@/lib/api/types';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';

import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { getLanguageFromExtension, isImageFile } from '@/lib/toolHelpers';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { DiffViewToggle } from '@/components/chat/message/DiffViewToggle';
import type { DiffViewMode } from '@/components/chat/message/types';
import { PierreDiffViewer } from './PierreDiffViewer';
import { useDeviceInfo } from '@/lib/device';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';

// Minimum width for side-by-side diff view (px)
const SIDE_BY_SIDE_MIN_WIDTH = 1100;
const DIFF_REQUEST_TIMEOUT_MS = 15000;

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

type DiffData = { original: string; modified: string; isBinary?: boolean };

const BinaryDiffPlaceholder = React.memo(() => {
    return (
        <div className="rounded-lg border border-border/60 bg-background px-3 py-2">
            <div className="typography-meta text-muted-foreground">Content of this file cannot be viewed.</div>
        </div>
    );
});

type DiffTabViewMode = 'single' | 'stacked';

type ChangeDescriptor = {
    code: string;
    color: string;
    description: string;
};

const CHANGE_DESCRIPTORS: Record<string, ChangeDescriptor> = {
    '?': { code: '?', color: 'var(--status-info)', description: 'Untracked file' },
    A: { code: 'A', color: 'var(--status-success)', description: 'New file' },
    D: { code: 'D', color: 'var(--status-error)', description: 'Deleted file' },
    R: { code: 'R', color: 'var(--status-info)', description: 'Renamed file' },
    C: { code: 'C', color: 'var(--status-info)', description: 'Copied file' },
    M: { code: 'M', color: 'var(--status-warning)', description: 'Modified file' },
};

const DEFAULT_CHANGE_DESCRIPTOR = CHANGE_DESCRIPTORS.M;

const DIFF_VIEW_MODE_OPTIONS: Array<{
    value: DiffTabViewMode;
    label: string;
    description: string;
}> = [
    {
        value: 'single',
        label: 'Single file',
        description: 'Show one file at a time',
    },
    {
        value: 'stacked',
        label: 'All files',
        description: 'Stack all modified files together',
    },
];

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

const formatDiffTotals = (insertions?: number, deletions?: number) => {
    const added = insertions ?? 0;
    const removed = deletions ?? 0;
    if (!added && !removed) return null;
    return (
        <span className="typography-meta flex flex-shrink-0 items-center gap-1 text-xs whitespace-nowrap">
            {added ? <span style={{ color: 'var(--status-success)' }}>+{added}</span> : null}
            {removed ? <span style={{ color: 'var(--status-error)' }}>-{removed}</span> : null}
        </span>
    );
};

interface FileSelectorProps {
    changedFiles: FileEntry[];
    selectedFile: string | null;
    selectedFileEntry: FileEntry | null;
    onSelectFile: (path: string) => void;
    isMobile: boolean;
    showModeSelector?: boolean;
    mode?: DiffTabViewMode;
    onModeChange?: (mode: DiffTabViewMode) => void;
}

const FileSelector = React.memo<FileSelectorProps>(({
    changedFiles,
    selectedFile,
    selectedFileEntry,
    onSelectFile,
    isMobile,
    showModeSelector = false,
    mode,
    onModeChange,
}) => {
    const getLabel = React.useCallback((path: string) => {
        if (!isMobile) return path;
        const lastSlash = path.lastIndexOf('/');
        return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
    }, [isMobile]);

    if (changedFiles.length === 0) return null;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button className="flex h-8 items-center gap-2 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground outline-none hover:bg-interactive-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                    {selectedFileEntry ? (
                        <div className="flex min-w-0 items-center gap-3">
                            <FileTypeIcon filePath={selectedFileEntry.path} className="h-3.5 w-3.5 flex-shrink-0" />
                            <span className="min-w-0 flex-1 truncate typography-meta">
                                {getLabel(selectedFileEntry.path)}
                            </span>
                            {formatDiffTotals(selectedFileEntry.insertions, selectedFileEntry.deletions)}
                        </div>
                    ) : (
                        <span className="text-muted-foreground">Select file</span>
                    )}
                    <RiArrowDownSLine className="size-4 opacity-50" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-[70vh] min-w-[320px] overflow-y-auto">
                {showModeSelector && mode && onModeChange ? (
                    <>
                        <DropdownMenuLabel className="typography-meta text-muted-foreground">
                            View mode
                        </DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                            value={mode}
                            onValueChange={(value) => onModeChange(value as DiffTabViewMode)}
                        >
                            {DIFF_VIEW_MODE_OPTIONS.map((option) => (
                                <DropdownMenuRadioItem
                                    key={option.value}
                                    value={option.value}
                                    className="items-center"
                                >
                                    <span className="typography-meta text-foreground">
                                        {option.label}
                                    </span>
                                </DropdownMenuRadioItem>
                            ))}
                        </DropdownMenuRadioGroup>
                        <DropdownMenuSeparator />
                    </>
                ) : null}
                <DropdownMenuRadioGroup value={selectedFile ?? ''} onValueChange={onSelectFile}>
                    {changedFiles.map((file) => (
                        <DropdownMenuRadioItem key={file.path} value={file.path}>
                            <div className="flex w-full min-w-0 items-center gap-3">
                                <FileTypeIcon filePath={file.path} className="h-3.5 w-3.5 flex-shrink-0" />
                                <span className="min-w-0 flex-1 truncate typography-meta">
                                    {getLabel(file.path)}
                                </span>
                                <span className="ml-auto">
                                    {formatDiffTotals(file.insertions, file.deletions)}
                                </span>
                            </div>
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
});

interface DiffViewModeSelectorProps {
    mode: DiffTabViewMode;
    onModeChange: (mode: DiffTabViewMode) => void;
}

const DiffViewModeSelector = React.memo<DiffViewModeSelectorProps>(({ mode, onModeChange }) => {
    const currentOption =
        DIFF_VIEW_MODE_OPTIONS.find((option) => option.value === mode) ?? DIFF_VIEW_MODE_OPTIONS[0];

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button className="flex h-8 items-center gap-2 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground outline-none hover:bg-interactive-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="min-w-0 truncate typography-meta">
                        {currentOption.label}
                    </span>
                    <RiArrowDownSLine className="size-4 opacity-50" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-[220px]">
                <DropdownMenuRadioGroup
                    value={mode}
                    onValueChange={(value) => onModeChange(value as DiffTabViewMode)}
                >
                    {DIFF_VIEW_MODE_OPTIONS.map((option) => (
                        <DropdownMenuRadioItem key={option.value} value={option.value}>
                            <div className="flex flex-col gap-0.5">
                                <span className="typography-meta text-foreground">
                                    {option.label}
                                </span>
                                <span className="typography-micro text-muted-foreground">
                                    {option.description}
                                </span>
                            </div>
                        </DropdownMenuRadioItem>
                    ))}
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
                                    title={descriptor.description}
                                    aria-label={descriptor.description}
                                >
                                    {descriptor.code}
                                </span>
                                <span
                                    className="min-w-0 flex-1 truncate typography-meta"
                                    style={{ direction: 'rtl', textAlign: 'left' }}
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
interface ImageDiffViewerProps {
    filePath: string;
    diff: DiffData;
    isVisible: boolean;
    renderSideBySide: boolean;
}

const ImageDiffViewer = React.memo<ImageDiffViewerProps>(({
    filePath,
    diff,
    isVisible,
    renderSideBySide,
}) => {
    const hasOriginal = diff.original.length > 0;
    const hasModified = diff.modified.length > 0;

    if (!isVisible) {
        return <div className="absolute inset-0 hidden" />;
    }

    // Render side-by-side or stacked based on preference
    const containerClass = renderSideBySide
        ? 'flex flex-row gap-6 items-start justify-center h-full'
        : 'flex flex-col gap-4 items-center';

    const imageContainerClass = renderSideBySide
        ? 'flex flex-col items-center gap-2 flex-1 min-w-0 h-full'
        : 'flex flex-col items-center gap-2';

    return (
        <div className="absolute inset-0 overflow-auto p-4" style={{ contain: 'size layout' }}>
            <div className={containerClass}>
                {hasOriginal && (
                    <div className={imageContainerClass}>
                        <span className="typography-meta text-muted-foreground font-medium">Original</span>
                        <img
                            src={diff.original}
                            alt={`Original: ${filePath}`}
                            className={renderSideBySide ? "max-w-full max-h-[calc(100%-2rem)] object-contain" : "max-w-full object-contain"}
                            style={{ imageRendering: 'auto' }}
                        />
                    </div>
                )}
                {hasModified && (
                    <div className={imageContainerClass}>
                        <span className="typography-meta text-muted-foreground font-medium">
                            {hasOriginal ? 'Modified' : 'New'}
                        </span>
                        <img
                            src={diff.modified}
                            alt={`Modified: ${filePath}`}
                            className={renderSideBySide ? "max-w-full max-h-[calc(100%-2rem)] object-contain" : "max-w-full object-contain"}
                            style={{ imageRendering: 'auto' }}
                        />
                    </div>
                )}
            </div>
        </div>
    );
});

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
                        <span className="typography-meta text-muted-foreground font-medium">Original</span>
                        <img
                            src={diff.original}
                            alt={`Original: ${filePath}`}
                            className={renderSideBySide ? "max-w-full max-h-[70vh] object-contain" : "max-w-full object-contain"}
                            style={{ imageRendering: 'auto' }}
                        />
                    </div>
                )}
                {hasModified && (
                    <div className={imageContainerClass}>
                        <span className="typography-meta text-muted-foreground font-medium">
                            {hasOriginal ? 'Modified' : 'New'}
                        </span>
                        <img
                            src={diff.modified}
                            alt={`Modified: ${filePath}`}
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
                language={language}
                fileName={filePath}
                renderSideBySide={renderSideBySide}
                wrapLines={wrapLines}
                layout="inline"
            />
        </div>
    );
});

// Single diff viewer instance
interface SingleDiffViewerProps {
    filePath: string;
    diff: DiffData;
    isVisible: boolean;
    renderSideBySide: boolean;
    wrapLines: boolean;
}

const SingleDiffViewer = React.memo<SingleDiffViewerProps>(({ 
    filePath,
    diff,
    isVisible,
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

    // Don't render if not visible (memory optimization)
    if (!isVisible) {
        return null;
    }

    // Check if this is an image file
    if (isImageFile(filePath)) {
        return (
            <ImageDiffViewer
                filePath={filePath}
                diff={diff}
                isVisible={isVisible}
                renderSideBySide={renderSideBySide}
            />
        );
    }

    return (
        <div className="absolute inset-0" style={{ contain: 'size layout' }}>
            <PierreDiffViewer
                original={diff.original}
                modified={diff.modified}
                language={language}
                fileName={filePath}
                renderSideBySide={renderSideBySide}
                wrapLines={wrapLines}
            />
        </div>
    );
});

interface MultiFileDiffEntryProps {
    directory: string;
    file: FileEntry;
    layout: 'inline' | 'side-by-side';
    wrapLines: boolean;
    scrollRootRef: React.RefObject<HTMLElement | null>;
    isSelected: boolean;
    onSelect: (path: string) => void;
    registerSectionRef: (path: string, node: HTMLDivElement | null) => void;
    /** Start collapsed to reduce memory with many files */
    defaultCollapsed?: boolean;
    expandRequestPath?: string | null;
    expandRequestNonce?: number;
}

const MultiFileDiffEntry = React.memo<MultiFileDiffEntryProps>(({
    directory,
    file,
    layout,
    wrapLines,
    scrollRootRef,
    isSelected,
    onSelect,
    registerSectionRef,
    defaultCollapsed = false,
    expandRequestPath = null,
    expandRequestNonce = 0,
}) => {
    const { git } = useRuntimeAPIs();
    const cachedDiff = useGitStore(
        React.useCallback((state) => {
            return state.directories.get(directory)?.diffCache.get(file.path) ?? null;
        }, [directory, file.path])
    );
    const setDiff = useGitStore((state) => state.setDiff);
    const setDiffFileLayout = useUIStore((state) => state.setDiffFileLayout);

    const [isExpanded, setIsExpanded] = React.useState(!defaultCollapsed);
    const [hasBeenVisible, setHasBeenVisible] = React.useState(false);
    const [diffRetryNonce, setDiffRetryNonce] = React.useState(0);
    const [diffLoadError, setDiffLoadError] = React.useState<string | null>(null);
    const [isLoading, setIsLoading] = React.useState(false);
    const lastDiffRequestRef = React.useRef<string | null>(null);
    const sectionRef = React.useRef<HTMLDivElement | null>(null);

    const descriptor = React.useMemo(() => describeChange(file), [file]);
    const renderSideBySide = layout === 'side-by-side';

    const diffData = React.useMemo<DiffData | null>(() => {
        if (!cachedDiff) return null;
        return { original: cachedDiff.original, modified: cachedDiff.modified, isBinary: cachedDiff.isBinary };
    }, [cachedDiff]);

    const setSectionRef = React.useCallback((node: HTMLDivElement | null) => {
        sectionRef.current = node;
        registerSectionRef(file.path, node);
    }, [file.path, registerSectionRef]);

    const handleOpenChange = React.useCallback((open: boolean) => {
        setIsExpanded(open);
        if (open) {
            setHasBeenVisible(true);
        }
    }, []);

    const handleSelect = React.useCallback(() => {
        onSelect(file.path);
    }, [file.path, onSelect]);

    React.useEffect(() => {
        if (!isExpanded || hasBeenVisible) return;
        const target = sectionRef.current;
        if (!target) return;

        if (!scrollRootRef.current || typeof IntersectionObserver === 'undefined') {
            setHasBeenVisible(true);
            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setHasBeenVisible(true);
                    observer.disconnect();
                }
            },
            { root: scrollRootRef.current, rootMargin: '200px 0px', threshold: 0.1 }
        );

        observer.observe(target);
        return () => observer.disconnect();
    }, [hasBeenVisible, isExpanded, scrollRootRef]);

    React.useEffect(() => {
        if (expandRequestNonce <= 0 || expandRequestPath !== file.path) {
            return;
        }

        setIsExpanded(true);
        setHasBeenVisible(true);
    }, [expandRequestNonce, expandRequestPath, file.path]);

    React.useEffect(() => {
        if (!isExpanded || !hasBeenVisible) return;
        if (!directory || diffData) {
            lastDiffRequestRef.current = null;
            setIsLoading(false);
            return;
        }

        const requestKey = `${directory}::${file.path}::${diffRetryNonce}`;
        if (lastDiffRequestRef.current === requestKey) {
            return;
        }
        lastDiffRequestRef.current = requestKey;
        setDiffLoadError(null);
        setIsLoading(true);

        let cancelled = false;
        const fetchPromise = git.getGitFileDiff(directory, { path: file.path });
        const timeoutMs = DIFF_REQUEST_TIMEOUT_MS;
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
        });

        void Promise.race([fetchPromise, timeoutPromise])
            .then((response) => {
                if (cancelled) return;

                setDiff(directory, file.path, {
                    original: response.original ?? '',
                    modified: response.modified ?? '',
                    isBinary: response.isBinary,
                });
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
    }, [directory, diffData, diffRetryNonce, file.path, git, hasBeenVisible, isExpanded, setDiff]);

    const handleToggle = React.useCallback(() => {
        handleOpenChange(!isExpanded);
        handleSelect();
    }, [handleOpenChange, handleSelect, isExpanded]);

    return (
        <div ref={setSectionRef} className="scroll-mt-4">
            <div className="sticky top-0 z-10 bg-background">
                <button
                    type="button"
                    onClick={handleToggle}
                    className={cn(
                        'group/header relative flex w-full items-center gap-2 px-3 py-1.5 rounded-t-xl border border-border/60 overflow-hidden',
                        'bg-background',
                        isExpanded ? 'rounded-b-none' : 'rounded-b-xl',
                        'text-muted-foreground hover:text-foreground',
                        isSelected ? 'ring-1 ring-inset ring-[var(--interactive-selection)]' : null
                    )}
                >
                    <div className="absolute inset-0 pointer-events-none group-hover/header:bg-interactive-hover" />
                    <div className="relative flex min-w-0 flex-1 items-center gap-2">
                        <span className="flex size-5 items-center justify-center opacity-70 group-hover/header:opacity-100">
                            {isExpanded ? (
                                <RiArrowDownSLine className="size-4" />
                            ) : (
                                <RiArrowRightSLine className="size-4" />
                            )}
                        </span>
                        <span
                            className="typography-micro font-semibold leading-none w-4 text-center uppercase"
                            style={{ color: descriptor.color }}
                            title={descriptor.description}
                            aria-label={descriptor.description}
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
                                                style={{ direction: 'rtl', textAlign: 'left' }}
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
                                                style={{ direction: 'rtl', textAlign: 'left' }}
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
                    <div className="relative flex items-center gap-2">
                        {formatDiffTotals(file.insertions, file.deletions)}
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
                </button>
            </div>
            {isExpanded && (
                <div className="relative border border-t-0 border-border/60 bg-background rounded-b-xl overflow-hidden">
                    {diffLoadError ? (
                        <div className="flex flex-col items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
                            <div className="typography-ui-label font-semibold text-foreground">
                                Failed to load diff
                            </div>
                            <div className="typography-meta text-muted-foreground max-w-[32rem] text-center">
                                {diffLoadError}
                            </div>
                            <button
                                type="button"
                                className="typography-ui-label text-primary hover:underline"
                                onClick={() => setDiffRetryNonce((nonce) => nonce + 1)}
                            >
                                Retry
                            </button>
                        </div>
                    ) : null}
                    {isLoading && !diffData && !diffLoadError ? (
                        <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
                            <RiLoader4Line size={16} className="animate-spin" />
                            Loading diff…
                        </div>
                    ) : null}
                    {diffData ? (
                        <InlineDiffViewer
                            filePath={file.path}
                            diff={diffData}
                            renderSideBySide={renderSideBySide}
                            wrapLines={wrapLines}
                        />
                    ) : null}
                </div>
            )}
        </div>
    );
});

interface DiffViewProps {
    hideStackedFileSidebar?: boolean;
    stackedDefaultCollapsedAll?: boolean;
    hideFileSelector?: boolean;
    pinSelectedFileHeaderToTopOnNavigate?: boolean;
}

export const DiffView: React.FC<DiffViewProps> = ({
    hideStackedFileSidebar = false,
    stackedDefaultCollapsedAll = false,
    hideFileSelector = false,
    pinSelectedFileHeaderToTopOnNavigate = false,
}) => {
    const { git } = useRuntimeAPIs();
    const effectiveDirectory = useEffectiveDirectory();
    const { screenWidth, isMobile } = useDeviceInfo();

    const isGitRepo = useIsGitRepo(effectiveDirectory ?? null);
    const status = useGitStatus(effectiveDirectory ?? null);
    const isLoadingStatus = useGitStore((state) => state.isLoadingStatus);
    const { setActiveDirectory, fetchStatus, setDiff } = useGitStore();
	 
    const [selectedFile, setSelectedFile] = React.useState<string | null>(null);
    const [stackedExpandTarget, setStackedExpandTarget] = React.useState<string | null>(null);
    const [stackedExpandRequestNonce, setStackedExpandRequestNonce] = React.useState(0);
    const [pinnedStackedTarget, setPinnedStackedTarget] = React.useState<string | null>(null);
    const [diffRetryNonce, setDiffRetryNonce] = React.useState(0);
    const [diffLoadError, setDiffLoadError] = React.useState<string | null>(null);
    const lastDiffRequestRef = React.useRef<string | null>(null);

    const pendingDiffFile = useUIStore((state) => state.pendingDiffFile);
    const setPendingDiffFile = useUIStore((state) => state.setPendingDiffFile);
    const diffLayoutPreference = useUIStore((state) => state.diffLayoutPreference);
    const diffFileLayout = useUIStore((state) => state.diffFileLayout);
    const setDiffFileLayout = useUIStore((state) => state.setDiffFileLayout);
    const diffWrapLinesStore = useUIStore((state) => state.diffWrapLines);
    const setDiffWrapLines = useUIStore((state) => state.setDiffWrapLines);
    const diffViewMode = useUIStore((state) => state.diffViewMode);
    const setDiffViewMode = useUIStore((state) => state.setDiffViewMode);
    // Default to wrap on mobile
    const diffWrapLines = isMobile || diffWrapLinesStore;

    const isStackedView = diffViewMode === 'stacked';
    const isMobileLayout = isMobile || screenWidth <= 768;
    const showFileSidebar = !hideStackedFileSidebar && !isMobileLayout && screenWidth >= 1024;
    const diffScrollRef = React.useRef<HTMLElement | null>(null);
    const fileSectionRefs = React.useRef(new Map<string, HTMLDivElement | null>());
    const pendingScrollTargetRef = React.useRef<string | null>(null);
    const pendingScrollFrameRef = React.useRef<number | null>(null);
    const shouldPinAfterAlignRef = React.useRef(false);


    React.useEffect(() => {
        if (!pinSelectedFileHeaderToTopOnNavigate || !isStackedView || !pinnedStackedTarget) {
            return;
        }

        const scrollRoot = diffScrollRef.current;
        if (!scrollRoot) {
            return;
        }

        let rafId: number | null = null;
        let cancelled = false;
        let stableFrames = 0;
        const stopAt = Date.now() + 1200;
        let ignoreNextScrollEvents = 0;

        const stop = () => {
            if (cancelled) {
                return;
            }
            cancelled = true;
            setPinnedStackedTarget(null);
        };

        const cancelOnUserInput = () => {
            stop();
        };

        const cancelOnScroll = () => {
            if (ignoreNextScrollEvents > 0) {
                ignoreNextScrollEvents -= 1;
                return;
            }
            stop();
        };

        window.addEventListener('wheel', cancelOnUserInput, { passive: true, capture: true });
        window.addEventListener('touchstart', cancelOnUserInput, { passive: true, capture: true });
        window.addEventListener('pointerdown', cancelOnUserInput, { capture: true });
        window.addEventListener('keydown', cancelOnUserInput, { capture: true });
        scrollRoot.addEventListener('scroll', cancelOnScroll, { passive: true });

        const tick = () => {
            if (cancelled || Date.now() > stopAt) {
                stop();
                return;
            }

            const currentScrollRoot = diffScrollRef.current;
            const node = fileSectionRefs.current.get(pinnedStackedTarget);
            if (!currentScrollRoot || !node) {
                stop();
                return;
            }

            const rootRect = currentScrollRoot.getBoundingClientRect();
            const nodeRect = node.getBoundingClientRect();
            const delta = nodeRect.top - rootRect.top;

            if (Math.abs(delta) <= 1) {
                stableFrames += 1;
                if (stableFrames >= 2) {
                    stop();
                    return;
                }
            } else {
                stableFrames = 0;
                const maxTop = Math.max(0, currentScrollRoot.scrollHeight - currentScrollRoot.clientHeight);
                const nextTop = Math.min(maxTop, Math.max(0, currentScrollRoot.scrollTop + delta));
                if (Math.abs(nextTop - currentScrollRoot.scrollTop) <= 0.5) {
                    stop();
                    return;
                }
                ignoreNextScrollEvents += 1;
                currentScrollRoot.scrollTop = nextTop;
            }

            rafId = window.requestAnimationFrame(tick);
        };

        rafId = window.requestAnimationFrame(tick);

        return () => {
            cancelled = true;
            if (rafId !== null) {
                window.cancelAnimationFrame(rafId);
            }
            window.removeEventListener('wheel', cancelOnUserInput, true);
            window.removeEventListener('touchstart', cancelOnUserInput, true);
            window.removeEventListener('pointerdown', cancelOnUserInput, true);
            window.removeEventListener('keydown', cancelOnUserInput, true);
            scrollRoot.removeEventListener('scroll', cancelOnScroll);
        };
    }, [isStackedView, pinSelectedFileHeaderToTopOnNavigate, pinnedStackedTarget]);

    const changedFiles: FileEntry[] = React.useMemo(() => {
        if (!status?.files) return [];
        const diffStats = status.diffStats ?? {};

        return status.files
            .map((file) => ({
                ...file,
                insertions: diffStats[file.path]?.insertions ?? 0,
                deletions: diffStats[file.path]?.deletions ?? 0,
                isNew: isNewStatusFile(file),
            }))
            .sort((a, b) => a.path.localeCompare(b.path));
    }, [status]);

    const selectedFileEntry = React.useMemo(() => {
        if (!selectedFile) return null;
        return changedFiles.find((file) => file.path === selectedFile) ?? null;
    }, [changedFiles, selectedFile]);

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

    const currentLayoutForSelectedFile = React.useMemo<'inline' | 'side-by-side' | null>(() => {
        if (!selectedFileEntry) return null;
        return getLayoutForFile(selectedFileEntry);
    }, [getLayoutForFile, selectedFileEntry]);

    // Fetch git status on mount
    React.useEffect(() => {
        if (effectiveDirectory) {
            setActiveDirectory(effectiveDirectory);
            const dirState = useGitStore.getState().directories.get(effectiveDirectory);
            if (!dirState?.status) {
                fetchStatus(effectiveDirectory, git);
            }
        }
    }, [effectiveDirectory, setActiveDirectory, fetchStatus, git]);

    // Handle pending diff file from external navigation
    React.useEffect(() => {
        if (pendingDiffFile) {
            setSelectedFile(pendingDiffFile);
            setPendingDiffFile(null);
            if (isStackedView) {
                shouldPinAfterAlignRef.current = true;
                pendingScrollTargetRef.current = pendingDiffFile;
                setStackedExpandTarget(pendingDiffFile);
                setStackedExpandRequestNonce((nonce) => nonce + 1);
            }
        }
    }, [isStackedView, pendingDiffFile, setPendingDiffFile]);

    // Auto-select first file (skip if we have a pending file to consume)
    React.useEffect(() => {
        if (!selectedFile && !pendingDiffFile && changedFiles.length > 0) {
            setSelectedFile(changedFiles[0].path);
        }
    }, [changedFiles, selectedFile, pendingDiffFile]);

    // Clear selection if file no longer exists
    React.useEffect(() => {
        if (selectedFile && changedFiles.length > 0) {
            const stillExists = changedFiles.some((f) => f.path === selectedFile);
            if (!stillExists) {
                setSelectedFile(changedFiles[0]?.path ?? null);
            }
        }
    }, [changedFiles, selectedFile]);

    const registerSectionRef = React.useCallback((path: string, node: HTMLDivElement | null) => {
        const map = fileSectionRefs.current;
        if (node) {
            map.set(path, node);
        } else {
            map.delete(path);
        }
    }, []);

    type ScrollToFileResult = {
        ok: boolean;
        aligned: boolean;
        didMove: boolean;
        atScrollLimit: boolean;
        delta: number;
    };

    const scrollToFile = React.useCallback((path: string): ScrollToFileResult => {
        const node = fileSectionRefs.current.get(path);
        const scrollRoot = diffScrollRef.current;
        if (!node || !scrollRoot) {
            return { ok: false, aligned: false, didMove: false, atScrollLimit: false, delta: 0 };
        }

        const rootRect = scrollRoot.getBoundingClientRect();
        const nodeRect = node.getBoundingClientRect();
        const delta = nodeRect.top - rootRect.top;

        const maxTop = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
        const desiredTop = scrollRoot.scrollTop + delta;
        const nextTop = Math.min(maxTop, Math.max(0, desiredTop));
        const didMove = Math.abs(nextTop - scrollRoot.scrollTop) > 0.5;
        scrollRoot.scrollTop = nextTop;

        const aligned = Math.abs(delta) <= 1;
        const atScrollLimit = nextTop <= 0.5 || nextTop >= maxTop - 0.5;

        return { ok: true, aligned, didMove, atScrollLimit, delta };
    }, []);

    React.useEffect(() => {
        if (!isStackedView) {
            pendingScrollTargetRef.current = null;
            shouldPinAfterAlignRef.current = false;
            if (pendingScrollFrameRef.current !== null) {
                window.cancelAnimationFrame(pendingScrollFrameRef.current);
                pendingScrollFrameRef.current = null;
            }
            return;
        }

        const target = pendingScrollTargetRef.current;
        if (!target) return;

        let attempts = 0;
        const maxAttempts = 120;
        let cancelled = false;
        let ignoreNextScrollEvents = 0;
        let didRemoveListeners = false;
        let stallFrames = 0;
        const stopAt = Date.now() + 2000;

        const removeListeners = () => {
            if (didRemoveListeners) {
                return;
            }
            didRemoveListeners = true;
            window.removeEventListener('wheel', cancelOnUserInput, true);
            window.removeEventListener('touchstart', cancelOnUserInput, true);
            window.removeEventListener('pointerdown', cancelOnUserInput, true);
            window.removeEventListener('keydown', cancelOnUserInput, true);
            scrollRoot?.removeEventListener('scroll', cancelOnScroll);
        };

        const cancelPending = () => {
            if (cancelled) {
                return;
            }
            cancelled = true;
            removeListeners();
            pendingScrollTargetRef.current = null;
            shouldPinAfterAlignRef.current = false;
            if (pendingScrollFrameRef.current !== null) {
                window.cancelAnimationFrame(pendingScrollFrameRef.current);
                pendingScrollFrameRef.current = null;
            }
        };

        const cancelOnUserInput = () => {
            cancelPending();
        };

        const cancelOnScroll = () => {
            if (ignoreNextScrollEvents > 0) {
                ignoreNextScrollEvents -= 1;
                return;
            }
            cancelPending();
        };

        const scrollRoot = diffScrollRef.current;
        window.addEventListener('wheel', cancelOnUserInput, { passive: true, capture: true });
        window.addEventListener('touchstart', cancelOnUserInput, { passive: true, capture: true });
        window.addEventListener('pointerdown', cancelOnUserInput, { capture: true });
        window.addEventListener('keydown', cancelOnUserInput, { capture: true });
        scrollRoot?.addEventListener('scroll', cancelOnScroll, { passive: true });

        const tryAlign = () => {
            if (Date.now() > stopAt) {
                cancelPending();
                pendingScrollFrameRef.current = null;
                return;
            }
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

            ignoreNextScrollEvents += 1;
            const result = scrollToFile(currentTarget);
            if (!result.ok) {
                ignoreNextScrollEvents = Math.max(0, ignoreNextScrollEvents - 1);
                attempts += 1;
                if (attempts < maxAttempts) {
                    pendingScrollFrameRef.current = window.requestAnimationFrame(tryAlign);
                } else {
                    cancelPending();
                    pendingScrollFrameRef.current = null;
                }
                return;
            }

            if (!result.aligned) {
                attempts += 1;
                if (!result.didMove) {
                    stallFrames += 1;
                    // If we're clamped (e.g. target is near bottom) give layout a few frames to settle
                    // (diff expansion / highlight can change scrollHeight), but don't fight user input.
                    if (stallFrames < 6 && (result.atScrollLimit || Math.abs(result.delta) > 1)) {
                        pendingScrollFrameRef.current = window.requestAnimationFrame(tryAlign);
                        return;
                    }
                } else {
                    stallFrames = 0;
                    if (attempts < maxAttempts) {
                        pendingScrollFrameRef.current = window.requestAnimationFrame(tryAlign);
                        return;
                    }
                }
            }

            if (pinSelectedFileHeaderToTopOnNavigate && shouldPinAfterAlignRef.current) {
                setPinnedStackedTarget(currentTarget);
            }
            cancelPending();
        };

        pendingScrollFrameRef.current = window.requestAnimationFrame(tryAlign);

        return () => {
            cancelled = true;
            removeListeners();
            if (pendingScrollFrameRef.current !== null) {
                window.cancelAnimationFrame(pendingScrollFrameRef.current);
                pendingScrollFrameRef.current = null;
            }
        };
    }, [isStackedView, pinSelectedFileHeaderToTopOnNavigate, scrollToFile, selectedFile, stackedExpandRequestNonce]);

    const handleSelectFile = React.useCallback((value: string) => {
        setSelectedFile(value);
    }, []);

    const handleSelectFileAndScroll = React.useCallback((value: string) => {
        if (pendingScrollFrameRef.current !== null) {
            window.cancelAnimationFrame(pendingScrollFrameRef.current);
            pendingScrollFrameRef.current = null;
        }
        pendingScrollTargetRef.current = null;

        setSelectedFile(value);

        if (!isStackedView) {
            shouldPinAfterAlignRef.current = false;
            return;
        }

        shouldPinAfterAlignRef.current = true;
        pendingScrollTargetRef.current = value;
        scrollToFile(value);
    }, [isStackedView, scrollToFile]);

    const handleDiffViewModeChange = React.useCallback((mode: DiffTabViewMode) => {
        setDiffViewMode(mode);
        if (mode === 'stacked' && selectedFile) {
            const result = scrollToFile(selectedFile);
            if (!result.aligned) {
                pendingScrollTargetRef.current = selectedFile;
            }
        }
    }, [scrollToFile, selectedFile, setDiffViewMode]);

    const handleHeaderLayoutChange = React.useCallback((mode: DiffViewMode) => {
        const nextLayout: 'inline' | 'side-by-side' =
            mode === 'side-by-side' ? 'side-by-side' : 'inline';

        if (isStackedView) {
            changedFiles.forEach((file) => {
                setDiffFileLayout(file.path, nextLayout);
            });
            return;
        }

        if (!selectedFileEntry) return;
        setDiffFileLayout(selectedFileEntry.path, nextLayout);
    }, [changedFiles, isStackedView, selectedFileEntry, setDiffFileLayout]);

    const renderSideBySide = (currentLayoutForSelectedFile ?? 'side-by-side') === 'side-by-side';
    const showFileSelector = !hideFileSelector && (!isStackedView || !showFileSidebar);

    const selectedCachedDiff = useGitStore(React.useCallback((state) => {
        if (!effectiveDirectory || !selectedFile) return null;
        return state.directories.get(effectiveDirectory)?.diffCache.get(selectedFile) ?? null;
    }, [effectiveDirectory, selectedFile]));

    const selectedDiffData = React.useMemo<DiffData | null>(() => {
        if (!selectedCachedDiff) return null;
        return { original: selectedCachedDiff.original, modified: selectedCachedDiff.modified, isBinary: selectedCachedDiff.isBinary };
    }, [selectedCachedDiff]);

    const hasCurrentDiff = !!selectedCachedDiff;
    const isCurrentFileLoading = !isStackedView && !!selectedFile && !hasCurrentDiff;

    React.useEffect(() => {
        if (isStackedView) {
            return;
        }

        setDiffLoadError(null);

        if (!effectiveDirectory || !selectedFile) {
            lastDiffRequestRef.current = null;
            return;
        }

        if (selectedCachedDiff) {
            lastDiffRequestRef.current = null;
            return;
        }

        const requestKey = `${effectiveDirectory}::${selectedFile}::${diffRetryNonce}`;
        if (lastDiffRequestRef.current === requestKey) {
            return;
        }
        lastDiffRequestRef.current = requestKey;

        let cancelled = false;
        const fetchPromise = git.getGitFileDiff(effectiveDirectory, { path: selectedFile });
        const timeoutMs = DIFF_REQUEST_TIMEOUT_MS;
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
        });

        void Promise.race([fetchPromise, timeoutPromise])
            .then((response) => {
                if (cancelled) return;

                setDiff(effectiveDirectory, selectedFile, {
                    original: response.original ?? '',
                    modified: response.modified ?? '',
                    isBinary: response.isBinary,
                });
            })
            .catch((error) => {
                if (cancelled) return;
                const message = error instanceof Error ? error.message : String(error);
                setDiffLoadError(message);
            });

        return () => {
            cancelled = true;
            if (lastDiffRequestRef.current === requestKey) {
                // Allow a retry if this request was cancelled due to directory/path churn.
                lastDiffRequestRef.current = null;
            }
        };
    }, [effectiveDirectory, isStackedView, selectedFile, selectedCachedDiff, git, setDiff, diffRetryNonce]);

    // Render only the selected diff viewer to prevent memory bloat with many files
    const renderSelectedDiffViewer = () => {
        if (!effectiveDirectory || !selectedFile || !selectedDiffData) return null;

        return (
            <SingleDiffViewer
                key={selectedFile}
                filePath={selectedFile}
                diff={selectedDiffData}
                isVisible={true}
                renderSideBySide={renderSideBySide}
                wrapLines={diffWrapLines}
            />
        );
    };

    const renderStackedDiffView = () => {
        if (!effectiveDirectory) return null;

        const defaultExpandedCount = getStackedViewDefaultExpandedCount(changedFiles.length);

        return (
            <div className="flex flex-1 min-h-0 h-full gap-3 px-3 pb-3 pt-2">
                {showFileSidebar && (
                    <section className="hidden lg:flex w-72 flex-col rounded-xl border border-border/60 bg-background/70 overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40">
                            <span className="typography-ui-header font-semibold text-foreground">Files</span>
                            <span className="typography-meta text-muted-foreground">{changedFiles.length}</span>
                        </div>
                        <FileList
                            changedFiles={changedFiles}
                            selectedFile={selectedFile}
                            onSelectFile={handleSelectFileAndScroll}
                        />
                    </section>
                )}
                <ScrollableOverlay
                    ref={diffScrollRef}
                    outerClassName="flex-1 min-h-0 h-full"
                    className="pr-2"
                    disableHorizontal
                    observeMutations={false}
                    preventOverscroll
                    data-diff-virtual-root
                    data-diff-virtual-content
                >
                    <div className="flex flex-col gap-3">
                        {changedFiles.map((file, index) => (
                            <MultiFileDiffEntry
                                key={file.path}
                                directory={effectiveDirectory}
                                file={file}
                                layout={getLayoutForFile(file)}
                                wrapLines={diffWrapLines}
                                scrollRootRef={diffScrollRef}
                                isSelected={file.path === selectedFile}
                                onSelect={handleSelectFile}
                                registerSectionRef={registerSectionRef}
                                defaultCollapsed={stackedDefaultCollapsedAll ? true : index >= defaultExpandedCount}
                                expandRequestPath={stackedExpandTarget}
                                expandRequestNonce={stackedExpandRequestNonce}
                            />
                        ))}
                    </div>
                </ScrollableOverlay>
            </div>
        );
    };

    const renderContent = () => {

        if (!effectiveDirectory) {
            return (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    Select a session directory to view diffs
                </div>
            );
        }

        if (isLoadingStatus && !status) {
            return (
                <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <RiLoader4Line size={16} className="animate-spin" />
                    Loading repository status…
                </div>
            );
        }

        if (isGitRepo === false) {
            return (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    Not a git repository. Use the Git tab to initialize or change directories.
                </div>
            );
        }

        if (changedFiles.length === 0) {
            return (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    Working tree clean — no changes to display
                </div>
            );
        }

        if (isStackedView) {
            return renderStackedDiffView();
        }

        return (
            <div className="flex flex-1 min-h-0 overflow-hidden px-3 py-3 relative" data-diff-virtual-root data-diff-virtual-content>
                {renderSelectedDiffViewer()}
                {isCurrentFileLoading && !hasCurrentDiff && (
                    <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                        {diffLoadError ? (
                            <div className="flex flex-col items-center gap-2">
                                <div className="typography-ui-label font-semibold text-foreground">
                                    Failed to load diff
                                </div>
                                <div className="typography-meta text-muted-foreground max-w-[32rem] text-center">
                                    {diffLoadError}
                                </div>
                                <button
                                    type="button"
                                    className="typography-ui-label text-primary hover:underline"
                                    onClick={() => {
                                        setDiffLoadError(null);
                                        setDiffRetryNonce((n) => n + 1);
                                    }}
                                >
                                    Retry
                                </button>
                            </div>
                        ) : (
                            <>
                                <RiLoader4Line size={16} className="animate-spin" />
                                Loading diff…
                            </>
                        )}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background">
            <div className="flex items-center gap-3 px-3 py-2 bg-background">
                {!isMobile && (
                    <div className="flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground shrink-0">
                        <RiGitCommitLine size={16} />
                        <span className="typography-ui-label font-semibold text-foreground">
                            {isLoadingStatus && !status
                                ? 'Loading changes…'
                                : `${changedFiles.length} ${changedFiles.length === 1 ? 'file' : 'files'} changed`}
                        </span>
                    </div>
                )}
                {!isMobileLayout && (
                    <DiffViewModeSelector mode={diffViewMode} onModeChange={handleDiffViewModeChange} />
                )}
                {showFileSelector && (
                    <FileSelector
                        changedFiles={changedFiles}
                        selectedFile={selectedFile}
                        selectedFileEntry={selectedFileEntry}
                        onSelectFile={handleSelectFileAndScroll}
                        isMobile={isMobileLayout}
                        showModeSelector={isMobileLayout}
                        mode={diffViewMode}
                        onModeChange={handleDiffViewModeChange}
                    />
                )}
                <div className="flex-1" />
                {selectedFileEntry && (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDiffWrapLines(!diffWrapLinesStore)}
                        className={cn(
                            'h-5 w-5 p-0 transition-opacity',
                            diffWrapLines ? 'text-foreground opacity-100' : 'text-muted-foreground opacity-60 hover:opacity-100'
                        )}
                        title={diffWrapLines ? 'Disable line wrap' : 'Enable line wrap'}
                    >
                        <RiTextWrap className="size-4" />
                    </Button>
                )}
                {selectedFileEntry && currentLayoutForSelectedFile && (
                    <DiffViewToggle
                        mode={currentLayoutForSelectedFile === 'side-by-side' ? 'side-by-side' : 'unified'}
                        onModeChange={handleHeaderLayoutChange}
                    />
                )}
            </div>

            {renderContent()}
        </div>
    );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useDiffFileCount = (): number => {
    const { git } = useRuntimeAPIs();
    const effectiveDirectory = useEffectiveDirectory();

    const { setActiveDirectory, fetchStatus } = useGitStore();
    const fileCount = useGitFileCount(effectiveDirectory ?? null);

    React.useEffect(() => {
        if (effectiveDirectory) {
            setActiveDirectory(effectiveDirectory);

            const dirState = useGitStore.getState().directories.get(effectiveDirectory);
            if (!dirState?.status) {
                fetchStatus(effectiveDirectory, git);
            }
        }
    }, [effectiveDirectory, setActiveDirectory, fetchStatus, git]);

    return fileCount;
};
