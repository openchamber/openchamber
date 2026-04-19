import React from 'react';
import { RiFileEditLine, RiArrowDownSLine, RiArrowRightSLine, RiCloseLine } from '@remixicon/react';
import type { ToolPart } from '@opencode-ai/sdk/v2';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessageRecords } from '@/sync/sync-context';
import { useStreamingStore, selectIsStreaming } from '@/sync/streaming';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
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

/** Compute a simple signature hash for dismiss tracking */
const computeSignature = (files: ChangedFileEntry[]): string => {
    return files
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((f) => {
            const adds = isGitFile(f) ? f.insertions : (f.additions ?? 0);
            const dels = isGitFile(f) ? f.deletions : (f.deletions ?? 0);
            return `${f.path}:${adds}:${dels}`;
        })
        .join('|');
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
    const runtime = React.useContext(RuntimeAPIContext);
    const isGitRepo = useIsGitRepo(currentDirectory);
    const gitStatus = useGitStore((s) =>
        currentDirectory ? s.directories.get(currentDirectory)?.status ?? null : null,
    );
    const isStreaming = useStreamingStore(selectIsStreaming(currentSessionId ?? ''));
    const dismissedSignature = useSessionUIStore((s) => {
        const sid = s.currentSessionId;
        return sid ? s.pendingChangesBarDismissed.get(sid) ?? null : null;
    });

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

    // ---- Signature for dismiss tracking ----
    const currentSignature = React.useMemo(
        () => computeSignature(changedFiles),
        [changedFiles],
    );

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

    // Don't render while git status is still loading
    if (isGitRepo === null) return null;

    // ---- Dismiss logic ----
    const isDismissed = dismissedSignature !== null && dismissedSignature === currentSignature;

    // ---- Visibility ----
    if (changedFiles.length === 0 || isDismissed) return null;

    // ---- Handlers ----
    const handleOpenFile = (file: ChangedFileEntry) => {
        const absolutePath = file.path.startsWith('/')
            ? file.path
            : (currentDirectory.endsWith('/') ? currentDirectory : currentDirectory + '/') + file.path;

        const editor = runtime?.editor;
        if (editor && !isGitFile(file) && file.patch) {
            void editor.openDiff('', absolutePath, undefined, { patch: file.patch });
        } else if (editor) {
            void editor.openFile(absolutePath);
        } else {
            useUIStore.getState().openContextDiff(currentDirectory, absolutePath);
        }
    };

    const handleDismiss = (e: React.MouseEvent) => {
        e.stopPropagation();
        const sid = useSessionUIStore.getState().currentSessionId;
        if (sid) {
            useSessionUIStore.getState().dismissPendingChangesBar(sid, currentSignature);
        }
    };

    // ---- Label ----
    const fileCount = changedFiles.length;
    const label = mode === 'git'
        ? `${fileCount} file${fileCount !== 1 ? 's' : ''} changed in workspace`
        : `${fileCount} file${fileCount !== 1 ? 's' : ''} changed in the last reply`;

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
        <div
            className="border-b chat-column"
            style={{ borderColor: 'var(--tools-border)', backgroundColor: 'var(--tools-background)' }}
        >
            {isExpanded ? (
                <div className="py-2 px-1">
                    <div className="flex items-center gap-2 w-full">
                        <button
                            type="button"
                            className="flex items-center gap-2 typography-meta font-medium flex-1 text-left hover:opacity-80 transition-opacity min-w-0"
                            style={{ color: 'var(--tools-title)' }}
                            onClick={() => setIsExpanded(false)}
                        >
                            <RiArrowDownSLine className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--tools-icon)' }} />
                            <RiFileEditLine className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--tools-icon)' }} />
                            <span className="truncate">{label}</span>
                        </button>
                        <span className="ml-auto tabular-nums inline-flex items-center gap-0.5 flex-shrink-0">
                            {totalAdded > 0 && <span style={{ color: 'var(--status-success)' }}>+{totalAdded}</span>}
                            {totalRemoved > 0 && <span style={{ color: 'var(--status-error)' }}>-{totalRemoved}</span>}
                        </span>
                        <button
                            type="button"
                            className="flex-shrink-0 p-0.5 rounded hover:bg-muted/30 transition-colors"
                            onClick={handleDismiss}
                            title="Dismiss"
                        >
                            <RiCloseLine className="h-3.5 w-3.5" style={{ color: 'var(--tools-description)' }} />
                        </button>
                    </div>
                    <div className="flex flex-col gap-1 mt-2">
                        {changedFiles.map((file) => {
                            const { fileName, dirPart } = getDisplayPath(file);
                            const stats = getFileStats(file);

                            return (
                                <button
                                    key={file.path}
                                    type="button"
                                    className="flex items-center gap-1.5 typography-micro px-1.5 py-0.5 rounded hover:bg-muted/30 transition-colors text-left w-full"
                                    style={{ color: 'var(--tools-description)' }}
                                    title={`Open ${file.path}`}
                                    onClick={() => handleOpenFile(file)}
                                >
                                    <FileTypeIcon filePath={file.path} className="h-3 w-3 flex-shrink-0" />
                                    <span className="truncate flex-1" dir="rtl" style={{ textAlign: 'left' }}>
                                        {dirPart ? (
                                            <>
                                                <span style={{ color: 'var(--tools-description)', opacity: 0.7 }}>{dirPart}/</span>
                                                <span style={{ color: 'var(--tools-title)' }}>{fileName}</span>
                                            </>
                                        ) : (
                                            <span style={{ color: 'var(--tools-title)' }}>{fileName}</span>
                                        )}
                                    </span>
                                    {(stats.additions > 0 || stats.deletions > 0) && (
                                        <span className="flex-shrink-0 inline-flex items-center gap-px tabular-nums">
                                            {stats.additions > 0 && (
                                                <span style={{ color: 'var(--status-success)', fontSize: '0.7rem' }}>+{stats.additions}</span>
                                            )}
                                            {stats.deletions > 0 && (
                                                <span style={{ color: 'var(--status-error)', fontSize: '0.7rem' }}>-{stats.deletions}</span>
                                            )}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>
            ) : (
                <div className="py-1.5 flex items-center gap-2 px-1">
                    <button
                        type="button"
                        className="flex items-center gap-2 typography-meta font-medium hover:opacity-80 transition-opacity flex-shrink-0"
                        style={{ color: 'var(--tools-title)' }}
                        onClick={() => setIsExpanded(true)}
                    >
                        <RiArrowRightSLine className="h-3.5 w-3.5" style={{ color: 'var(--tools-icon)' }} />
                        <RiFileEditLine className="h-3.5 w-3.5" style={{ color: 'var(--tools-icon)' }} />
                    </button>
                    <span className="typography-meta font-medium flex-shrink-0 truncate" style={{ color: 'var(--tools-title)' }}>
                        {label}
                    </span>
                    <span className="tabular-nums flex-shrink-0 inline-flex items-center gap-0.5">
                        {totalAdded > 0 && <span style={{ color: 'var(--status-success)' }}>+{totalAdded}</span>}
                        {totalRemoved > 0 && <span style={{ color: 'var(--status-error)' }}>-{totalRemoved}</span>}
                    </span>
                    <button
                        type="button"
                        className="ml-auto flex-shrink-0 p-0.5 rounded hover:bg-muted/30 transition-colors"
                        onClick={handleDismiss}
                        title="Dismiss"
                    >
                        <RiCloseLine className="h-3.5 w-3.5" style={{ color: 'var(--tools-description)' }} />
                    </button>
                </div>
            )}
        </div>
    );
});

PendingChangesBar.displayName = 'PendingChangesBar';
