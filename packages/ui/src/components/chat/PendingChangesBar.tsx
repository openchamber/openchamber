import React from 'react';
import { RiFileEditLine, RiArrowDownSLine, RiArrowUpSLine } from '@remixicon/react';
import type { ToolPart } from '@opencode-ai/sdk/v2';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessageRecords } from '@/sync/sync-context';
import { useStreamingStore, selectIsStreaming } from '@/sync/streaming';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
// ---- Types ----

/** File changed by an AI tool (non-Git mode) */
interface ChangedFile {
    path: string;
    tool: string;
    partId: string;
    messageID: string;
    additions?: number;
    deletions?: number;
    patch?: string;
}

/** File changed in workspace (Git mode) */
interface GitChangedFile {
    path: string;
    relativePath: string;
    insertions: number;
    deletions: number;
    status: string;
}

type ChangedFileEntry = ChangedFile | GitChangedFile;

// ---- Helpers ----

const FILE_EDIT_TOOLS = new Set(['edit', 'multiedit', 'write', 'apply_patch', 'create', 'file_write']);

const parseCount = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
    return undefined;
};

const parsePatchStats = (patch: string): { added: number; removed: number } => {
    let added = 0;
    let removed = 0;
    for (const line of patch.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return { added, removed };
};

/** Extract changed files from tool parts of a single assistant message */
const extractChangedFiles = (parts: ToolPart[]): ChangedFile[] => {
    const files: ChangedFile[] = [];
    const seen = new Set<string>();

    for (const part of parts) {
        if (part.type !== 'tool') continue;
        if (!FILE_EDIT_TOOLS.has(part.tool)) continue;

        const state = part.state as { metadata?: Record<string, unknown>; input?: Record<string, unknown>; status?: string };
        if (state.status && state.status !== 'completed') continue;

        const sizeBeforeThisPart = files.length;

        const metadata = state.metadata;

        // Extract from metadata.files[] (apply_patch)
        const metaFiles = Array.isArray(metadata?.files) ? metadata.files : [];
        for (const file of metaFiles) {
            if (!file || typeof file !== 'object') continue;
            const record = file as { relativePath?: string; filePath?: string; additions?: unknown; deletions?: unknown; patch?: unknown };
            const rawPath = record.relativePath || record.filePath || '';
            if (!rawPath || seen.has(rawPath)) continue;
            seen.add(rawPath);
            files.push({
                path: rawPath,
                tool: part.tool,
                partId: part.id,
                messageID: part.messageID,
                additions: parseCount(record.additions) ?? undefined,
                deletions: parseCount(record.deletions) ?? undefined,
                patch: typeof record.patch === 'string' ? record.patch : undefined,
            });
        }

        // Fallback 1: extract from metadata.filediff (edit tool)
        if (metaFiles.length === 0 && metadata?.filediff && typeof metadata.filediff === 'object') {
            const fd = metadata.filediff as { file?: string; additions?: unknown; deletions?: unknown; patch?: unknown };
            const rawPath = typeof fd.file === 'string' ? fd.file : '';
            if (rawPath && !seen.has(rawPath)) {
                seen.add(rawPath);
                files.push({
                    path: rawPath,
                    tool: part.tool,
                    partId: part.id,
                    messageID: part.messageID,
                    additions: parseCount(fd.additions) ?? undefined,
                    deletions: parseCount(fd.deletions) ?? undefined,
                    patch: typeof fd.patch === 'string' ? fd.patch : undefined,
                });
            }
        }

        // Fallback 2: extract from metadata.results[].filediff (multiedit tool)
        if (metaFiles.length === 0 && Array.isArray(metadata?.results)) {
            for (const result of metadata.results) {
                if (!result || typeof result !== 'object') continue;
                const fd = (result as { filediff?: { file?: string; additions?: unknown; deletions?: unknown; patch?: unknown } }).filediff;
                if (!fd || typeof fd !== 'object') continue;
                const rawPath = typeof fd.file === 'string' ? fd.file : '';
                if (!rawPath || seen.has(rawPath)) continue;
                seen.add(rawPath);
                files.push({
                    path: rawPath,
                    tool: part.tool,
                    partId: part.id,
                    messageID: part.messageID,
                    additions: parseCount(fd.additions) ?? undefined,
                    deletions: parseCount(fd.deletions) ?? undefined,
                    patch: typeof fd.patch === 'string' ? fd.patch : undefined,
                });
            }
        }

        // Fallback 3: extract from input.filePath for write-like tools
        if (files.length === sizeBeforeThisPart) {
            const input = state.input;
            const filePath = typeof input?.filePath === 'string' ? input.filePath
                : typeof input?.file_path === 'string' ? input.file_path
                : typeof input?.path === 'string' ? input.path
                : undefined;
            if (filePath && !seen.has(filePath)) {
                seen.add(filePath);
                files.push({
                    path: filePath,
                    tool: part.tool,
                    partId: part.id,
                    messageID: part.messageID,
                });
            }
        }

        // Fallback 4: parse top-level patch/diff for stats
        if (files.length === sizeBeforeThisPart) {
            const patchText = typeof metadata?.patch === 'string' ? metadata.patch.trim()
                : typeof metadata?.diff === 'string' ? metadata.diff.trim() : '';
            if (patchText && !seen.has('Diff')) {
                seen.add('Diff');
                const parsed = parsePatchStats(patchText);
                files.push({
                    path: 'Diff',
                    tool: part.tool,
                    partId: part.id,
                    messageID: part.messageID,
                    additions: parsed.added,
                    deletions: parsed.removed,
                });
            }
        }
    }

    return files;
};

/** Convert absolute path to relative path based on current directory */
const toRelativePath = (absolutePath: string, baseDirectory: string): string => {
    const norm = (p: string) => p.split('\\').join('/').replace(/\/+$/, '');
    const base = norm(baseDirectory);
    const absPath = norm(absolutePath);
    if (absPath.startsWith(base + '/')) {
        return absPath.slice(base.length + 1);
    }
    if (absPath.startsWith(base)) {
        return absPath.slice(base.length) || absPath;
    }
    return absPath;
};

/** Extract changed files from GitStatus */
const extractGitChangedFiles = (
    files: Array<{ path: string; index: string; working_dir: string }>,
    diffStats: Record<string, { insertions: number; deletions: number }> | undefined,
    directory: string,
): GitChangedFile[] => {
    const result: GitChangedFile[] = [];
    for (const file of files) {
        const code = file.working_dir !== ' ' ? file.working_dir : file.index;
        if (code === '!' || code === ' ') continue;
        const stats = diffStats?.[file.path];
        result.push({
            path: file.path.startsWith('/') ? file.path : (directory.endsWith('/') ? directory : directory + '/') + file.path,
            relativePath: file.path,
            insertions: stats?.insertions ?? 0,
            deletions: stats?.deletions ?? 0,
            status: code,
        });
    }
    return result;
};

/** Type guard for GitChangedFile */
const isGitFile = (file: ChangedFileEntry): file is GitChangedFile => {
    return 'insertions' in file;
};

// ---- Component ----

export const PendingChangesBar: React.FC = React.memo(() => {
    const [isExpanded, setIsExpanded] = React.useState(false);
    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const sessionMessageRecords = useSessionMessageRecords(currentSessionId ?? '');
    const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
    const isGitRepo = useIsGitRepo(currentDirectory);
    const gitStatus = useGitStore((s) =>
        currentDirectory ? s.directories.get(currentDirectory)?.status ?? null : null,
    );
    const isStreaming = useStreamingStore(selectIsStreaming(currentSessionId ?? ''));
    const popoverRef = React.useRef<HTMLDivElement>(null);

    // ---- Mode selection ----
    const mode: 'git' | 'non-git' = isGitRepo === true ? 'git' : 'non-git';

    // ---- Git mode data ----
    const gitChangedFiles = React.useMemo(() => {
        if (isGitRepo !== true || mode !== 'git' || !gitStatus || gitStatus.isClean) return [];
        return extractGitChangedFiles(gitStatus.files, gitStatus.diffStats, currentDirectory);
    }, [isGitRepo, mode, gitStatus, currentDirectory]);

    // ---- Non-Git mode data (latest assistant turn only) ----
    const nonGitChangedFiles = React.useMemo(() => {
        if (isGitRepo !== false || mode !== 'non-git' || !currentSessionId || isStreaming) return [];

        for (let i = sessionMessageRecords.length - 1; i >= 0; i--) {
            const record = sessionMessageRecords[i];
            if (record.info.role !== 'assistant') continue;

            const toolParts = record.parts.filter(
                (p): p is ToolPart => p.type === 'tool' && FILE_EDIT_TOOLS.has(p.tool),
            );
            if (toolParts.length === 0) continue;

            return extractChangedFiles(toolParts);
        }
        return [];
    }, [isGitRepo, mode, sessionMessageRecords, currentSessionId, isStreaming]);

    // ---- Merged view ----
    const changedFiles: ChangedFileEntry[] = mode === 'git' ? gitChangedFiles : nonGitChangedFiles;

    // ---- Aggregate stats ----
    const { totalAdded, totalRemoved } = React.useMemo(() => {
        let added = 0;
        let removed = 0;
        for (const file of changedFiles) {
            if (isGitFile(file)) {
                added += file.insertions;
                removed += file.deletions;
            } else {
                if (file.additions != null) added += file.additions;
                if (file.deletions != null) removed += file.deletions;
            }
        }
        return { totalAdded: added, totalRemoved: removed };
    }, [changedFiles]);

    React.useEffect(() => {
        if (!isExpanded) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
                setIsExpanded(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isExpanded]);

    // Don't render while git status is still loading
    if (isGitRepo === null) return null;

    // ---- Visibility ----
    if (changedFiles.length === 0) return null;

    // ---- Handlers ----
    const handleOpenFile = (file: ChangedFileEntry) => {
        if (!currentDirectory) return;

        const targetPath = isGitFile(file)
            ? file.relativePath
            : toRelativePath(file.path, currentDirectory);

        const store = useUIStore.getState();
        if (!store.isMobile) {
            store.openContextDiff(currentDirectory, targetPath);
            return;
        }
        store.navigateToDiff(targetPath);
        store.setRightSidebarOpen(false);
    };

    // ---- Label ----
    const fileCount = changedFiles.length;
    const labelHead = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;
    const labelTail = mode === 'git' ? 'changed in workspace' : 'changed in the last reply';

    // ---- Display helpers ----
    const getDisplayPath = (file: ChangedFileEntry): { fileName: string; dirPart: string } => {
        const relativePath = isGitFile(file) && file.relativePath
            ? file.relativePath
            : toRelativePath(file.path, currentDirectory);
        const fileName = relativePath.split('/').pop() ?? relativePath;
        const dirPart = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '';
        return { fileName, dirPart };
    };

    const getFileStats = (file: ChangedFileEntry): { additions: number; deletions: number } => {
        if (isGitFile(file)) return { additions: file.insertions, deletions: file.deletions };
        return { additions: file.additions ?? 0, deletions: file.deletions ?? 0 };
    };

    // ---- Render ----
    return (
        <div className="relative flex min-w-0 items-center" ref={popoverRef}>
            <button
                type="button"
                onClick={() => setIsExpanded((prev) => !prev)}
                className="flex min-w-0 max-w-full items-center gap-1 text-left text-muted-foreground"
            >
                <RiFileEditLine className="h-3.5 w-3.5 flex-shrink-0 text-[var(--status-warning)]" />
                <span className="min-w-0 typography-ui-label text-foreground flex-shrink-0">{labelHead}</span>
                <span className="status-row__changed-label min-w-0 typography-ui-label text-foreground truncate">{labelTail}</span>
                <span className="text-[0.75rem] tabular-nums inline-flex items-baseline gap-1 flex-shrink-0">
                    {totalAdded > 0 ? <span style={{ color: 'var(--status-success)' }}>+{totalAdded}</span> : null}
                    {totalRemoved > 0 ? <span style={{ color: 'var(--status-error)' }}>-{totalRemoved}</span> : null}
                </span>
                {isExpanded ? (
                    <RiArrowUpSLine className="h-3.5 w-3.5 flex-shrink-0" />
                ) : (
                    <RiArrowDownSLine className="h-3.5 w-3.5 flex-shrink-0" />
                )}
            </button>

            {isExpanded ? (
                <div
                    style={{
                        maxWidth: 'calc(100cqw - 4ch)',
                        backgroundColor: 'var(--surface-elevated)',
                        color: 'var(--surface-elevated-foreground)',
                    }}
                    className="absolute left-0 bottom-full mb-1 z-50 w-max min-w-[280px] max-w-full rounded-xl p-1 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.8),inset_0_0_0_1px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.10),0_1px_2px_-0.5px_rgba(0,0,0,0.08),0_4px_8px_-2px_rgba(0,0,0,0.08),0_12px_20px_-4px_rgba(0,0,0,0.08)] dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_0_0_1px_rgba(255,255,255,0.08),0_0_0_1px_rgba(0,0,0,0.36),0_1px_1px_-0.5px_rgba(0,0,0,0.22),0_3px_3px_-1.5px_rgba(0,0,0,0.20),0_6px_6px_-3px_rgba(0,0,0,0.16)] animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 duration-150"
                >
                    <div className="flex items-center gap-1.5 px-2 py-1 typography-ui-label font-medium text-muted-foreground">
                        <span>Changed files</span>
                        <span className="typography-meta tabular-nums">{fileCount}</span>
                    </div>

                    <div className="max-h-[260px] overflow-y-auto">
                        {changedFiles.map((file, index) => {
                            const { fileName, dirPart } = getDisplayPath(file);
                            const stats = getFileStats(file);

                            return (
                                <button
                                    key={`${file.path}:${index}`}
                                    type="button"
                                    className="relative flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1 typography-ui-label outline-hidden select-none text-left hover:bg-interactive-hover"
                                    title={`Open diff for ${file.path}`}
                                    onClick={() => handleOpenFile(file)}
                                >
                                    <FileTypeIcon filePath={file.path} className="h-3.5 w-3.5 flex-shrink-0" />
                                    <span className="min-w-0 flex-1 flex items-baseline overflow-hidden" title={file.path}>
                                        {dirPart ? (
                                            <>
                                                <span
                                                    className="min-w-0 truncate text-muted-foreground"
                                                    style={{ direction: 'rtl', textAlign: 'left' }}
                                                >
                                                    {dirPart}
                                                </span>
                                                <span className="flex-shrink-0">
                                                    <span className="text-muted-foreground">/</span>
                                                    <span className="text-foreground">{fileName}</span>
                                                </span>
                                            </>
                                        ) : (
                                            <span className="truncate text-foreground">{fileName}</span>
                                        )}
                                    </span>
                                    {(stats.additions > 0 || stats.deletions > 0) ? (
                                        <span className="flex-shrink-0 inline-flex items-baseline gap-1 text-[0.75rem] tabular-nums">
                                            {stats.additions > 0 ? <span style={{ color: 'var(--status-success)' }}>+{stats.additions}</span> : null}
                                            {stats.deletions > 0 ? <span style={{ color: 'var(--status-error)' }}>-{stats.deletions}</span> : null}
                                        </span>
                                    ) : null}
                                </button>
                            );
                        })}
                    </div>
                </div>
            ) : null}
        </div>
    );
});

PendingChangesBar.displayName = 'PendingChangesBar';
