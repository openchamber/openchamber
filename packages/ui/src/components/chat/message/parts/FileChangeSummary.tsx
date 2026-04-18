import React from 'react';
import { RiArrowDownSLine, RiArrowRightSLine, RiCloseLine } from '@remixicon/react';
import { PatchDiff } from '@pierre/diffs/react';
import { cn } from '@/lib/utils';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { DiffViewToggle, type DiffViewMode } from '../DiffViewToggle';
import { revertGitFile } from '@/lib/gitApi';
import { parsePatchStats, parseCount } from './fileChangeHelpers';

// ---- Types ----

export interface FileDiffEntry {
    id: string;
    title: string;
    patch: string;
    additions?: number;
    deletions?: number;
}

interface FileChangeSummaryProps {
    entries: FileDiffEntry[];
    directory: string;
    pierreTheme: { light: string; dark: string };
    pierreThemeType: 'light' | 'dark';
}

// ---- Constants (mirrored from ToolPart.tsx) ----

const FILE_DIFF_METRICS = {
    hunkLineCount: 50,
    lineHeight: 24,
    diffHeaderHeight: 44,
    hunkSeparatorHeight: 24,
    fileGap: 0,
};

const FILE_DIFF_UNSAFE_CSS = `
  [data-diff-header],
  [data-diff] {
    [data-separator] {
      height: 24px !important;
    }
  }
`;

// ---- Sub-components ----

/** Summary header row: "N Changed files +X -Y" */
const SummaryHeader: React.FC<{
    fileCount: number;
    totalAdded: number;
    totalRemoved: number;
}> = ({ fileCount, totalAdded, totalRemoved }) => (
    <div className="flex items-center gap-2 px-2 py-1.5 typography-meta font-medium">
        <span style={{ color: 'var(--tools-title)' }}>
            {fileCount} Changed file{fileCount !== 1 ? 's' : ''}
        </span>
        <span className="inline-flex items-center gap-0.5 typography-meta tabular-nums" style={{ fontSize: '0.85rem' }}>
            <span style={{ color: 'var(--status-success)' }}>+{totalAdded}</span>
            <span style={{ color: 'var(--status-error)' }}>-{totalRemoved}</span>
        </span>
    </div>
);

/** Single file row: path + +/- stats + expand/collapse + reject */
const FileRow: React.FC<{
    entry: FileDiffEntry;
    isExpanded: boolean;
    isRejected: boolean;
    onToggle: (id: string) => void;
    onReject: (id: string) => void;
    diffViewMode: DiffViewMode;
    onDiffViewModeChange: (mode: DiffViewMode) => void;
    pierreTheme: { light: string; dark: string };
    pierreThemeType: 'light' | 'dark';
}> = React.memo(({ entry, isExpanded, isRejected, onToggle, onReject, diffViewMode, onDiffViewModeChange, pierreTheme, pierreThemeType }) => {
    const lastSlash = entry.title.lastIndexOf('/');
    const fileName = lastSlash === -1 ? entry.title : entry.title.slice(lastSlash + 1);
    const dirPath = lastSlash === -1 ? '' : entry.title.slice(0, lastSlash);
    const hasAbsoluteRoot = dirPath.startsWith('/');
    const displayDir = hasAbsoluteRoot ? dirPath.slice(1) : dirPath;

    // Prefer metadata additions/deletions, fall back to patch parsing
    const added = parseCount(entry.additions) ?? parsePatchStats(entry.patch).added;
    const removed = parseCount(entry.deletions) ?? parsePatchStats(entry.patch).removed;

    return (
        <div className="group/row rounded-lg overflow-hidden">
            {/* File row (clickable) */}
            <button
                type="button"
                className={cn(
                    'w-full flex items-center gap-2 px-2 py-1.5 text-left transition-colors',
                    'hover:bg-muted/30',
                    isExpanded && 'bg-muted/20',
                )}
                onClick={(e) => { e.stopPropagation(); onToggle(entry.id); }}
            >
                {/* Expand/collapse arrow */}
                <span className="flex-shrink-0 w-3.5 h-3.5 flex items-center justify-center">
                    {isExpanded
                        ? <RiArrowDownSLine className="w-3.5 h-3.5" style={{ color: 'var(--tools-description)' }} />
                        : <RiArrowRightSLine className="w-3.5 h-3.5" style={{ color: 'var(--tools-description)' }} />
                    }
                </span>

                {/* File icon */}
                <FileTypeIcon filePath={entry.title} className="h-3.5 w-3.5 flex-shrink-0" />

                {/* Path */}
                <span className="min-w-0 flex items-baseline gap-0 flex-1 overflow-hidden typography-meta" title={entry.title}>
                    {displayDir ? (
                        <>
                            {hasAbsoluteRoot ? <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span> : null}
                            <span
                                className="min-w-0 truncate"
                                style={{ color: 'var(--tools-description)', direction: 'rtl', textAlign: 'left' }}
                            >
                                {displayDir}
                            </span>
                            <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span>
                            <span className="flex-shrink-0" style={{ color: 'var(--tools-title)' }}>{fileName}</span>
                        </>
                    ) : (
                        <span className="truncate" style={{ color: 'var(--tools-title)' }}>{fileName}</span>
                    )}
                </span>

                {/* +/- stats */}
                <span className="flex-shrink-0 inline-flex items-center gap-0.5 typography-meta tabular-nums" style={{ fontSize: '0.85rem' }}>
                    <span style={{ color: 'var(--status-success)' }}>+{added}</span>
                    <span style={{ color: 'var(--status-error)' }}>-{removed}</span>
                </span>

                {/* Reject action */}
                {!isRejected && (
                    <button
                        type="button"
                        className="h-5 w-5 flex items-center justify-center rounded hover:bg-muted/50 transition-colors opacity-0 group-hover/row:opacity-100"
                        style={{ color: 'var(--status-error)' }}
                        title="Reject change (git revert)"
                        onClick={(e) => { e.stopPropagation(); onReject(entry.id); }}
                    >
                        <RiCloseLine className="h-3.5 w-3.5" />
                    </button>
                )}
                {isRejected && (
                    <span className="flex-shrink-0 typography-micro px-1.5 py-0.5 rounded" style={{ color: 'var(--status-error)', backgroundColor: 'var(--status-error-background)' }}>
                        Reverted
                    </span>
                )}
            </button>

            {/* Expanded diff preview */}
            {isExpanded && (
                <div className="pl-6 pr-1 pb-1">
                    <div className="flex items-center justify-end gap-2 mb-1">
                        <DiffViewToggle
                            mode={diffViewMode}
                            onModeChange={onDiffViewModeChange}
                            className="h-4 w-4 p-0"
                        />
                    </div>
                    <div className="typography-code px-1 pb-1 pt-0">
                        <PatchDiff
                            patch={entry.patch}
                            metrics={FILE_DIFF_METRICS}
                            options={{
                                diffStyle: diffViewMode === 'side-by-side' ? 'split' : 'unified',
                                diffIndicators: 'none',
                                hunkSeparators: 'line-info-basic',
                                lineDiffType: 'none',
                                disableFileHeader: true,
                                maxLineDiffLength: 1000,
                                expansionLineCount: 20,
                                overflow: 'wrap',
                                theme: pierreTheme,
                                themeType: pierreThemeType,
                                unsafeCSS: FILE_DIFF_UNSAFE_CSS,
                            }}
                            className="block w-full"
                        />
                    </div>
                </div>
            )}
        </div>
    );
});

FileRow.displayName = 'FileRow';

// ---- Main Component ----

export const FileChangeSummary: React.FC<FileChangeSummaryProps> = ({
    entries,
    directory,
    pierreTheme,
    pierreThemeType,
}) => {
    const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set());
    const [diffViewMode, setDiffViewMode] = React.useState<DiffViewMode>('unified');
    const [rejectedIds, setRejectedIds] = React.useState<Set<string>>(new Set());

    const handleToggle = React.useCallback((id: string) => {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }, []);

    const handleReject = React.useCallback((id: string) => {
        const entry = entries.find((e) => e.id === id);
        if (!entry) return;
        revertGitFile(directory, entry.title)
            .then(() => {
                setRejectedIds((prev) => new Set(prev).add(id));
            })
            .catch((err) => {
                console.error('Failed to revert file:', err);
            });
    }, [entries, directory]);

    // Aggregate stats — memoized to avoid recomputation
    const { totalAdded, totalRemoved } = React.useMemo(() => {
        let added = 0;
        let removed = 0;
        for (const entry of entries) {
            const a = parseCount(entry.additions) ?? parsePatchStats(entry.patch).added;
            const r = parseCount(entry.deletions) ?? parsePatchStats(entry.patch).removed;
            added += a;
            removed += r;
        }
        return { totalAdded: added, totalRemoved: removed };
    }, [entries]);

    if (entries.length === 0) return null;

    return (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--tools-border)' }}>
            <SummaryHeader
                fileCount={entries.length}
                totalAdded={totalAdded}
                totalRemoved={totalRemoved}
            />
            <div className="divide-y" style={{ borderColor: 'var(--tools-border)' }}>
                {entries.map((entry) => (
                    <FileRow
                        key={entry.id}
                        entry={entry}
                        isExpanded={expandedIds.has(entry.id)}
                        isRejected={rejectedIds.has(entry.id)}
                        onToggle={handleToggle}
                        onReject={handleReject}
                        diffViewMode={diffViewMode}
                        onDiffViewModeChange={setDiffViewMode}
                        pierreTheme={pierreTheme}
                        pierreThemeType={pierreThemeType}
                    />
                ))}
            </div>
        </div>
    );
};
