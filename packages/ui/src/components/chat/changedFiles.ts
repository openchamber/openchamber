import type { ToolPart } from '@opencode-ai/sdk/v2';

export interface ChangedFile {
    path: string;
    tool: string;
    partId: string;
    messageID: string;
    additions?: number;
    deletions?: number;
    patch?: string;
}

export interface GitChangedFile {
    path: string;
    relativePath: string;
    insertions: number;
    deletions: number;
    status: string;
}

export type ChangedFileEntry = ChangedFile | GitChangedFile;

export const FILE_EDIT_TOOLS = new Set(['edit', 'multiedit', 'write', 'apply_patch', 'create', 'file_write']);

export const isGitFile = (file: ChangedFileEntry): file is GitChangedFile => 'insertions' in file;

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

export const extractChangedFiles = (parts: ToolPart[]): ChangedFile[] => {
    const files: ChangedFile[] = [];
    const seen = new Set<string>();

    for (const part of parts) {
        if (part.type !== 'tool') continue;
        if (!FILE_EDIT_TOOLS.has(part.tool)) continue;

        const state = part.state as { metadata?: Record<string, unknown>; input?: Record<string, unknown>; status?: string };
        if (state.status && state.status !== 'completed') continue;

        const sizeBeforeThisPart = files.length;
        const metadata = state.metadata;

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

export const extractGitChangedFiles = (
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

export const toRelativePath = (absolutePath: string, baseDirectory: string): string => {
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

export const getDisplayPath = (file: ChangedFileEntry, currentDirectory: string): { fileName: string; dirPart: string } => {
    const relativePath = isGitFile(file) && file.relativePath
        ? file.relativePath
        : toRelativePath(file.path, currentDirectory);
    const fileName = relativePath.split('/').pop() ?? relativePath;
    const dirPart = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '';
    return { fileName, dirPart };
};

export const getFileStats = (file: ChangedFileEntry): { additions: number; deletions: number } => {
    if (isGitFile(file)) return { additions: file.insertions, deletions: file.deletions };
    return { additions: file.additions ?? 0, deletions: file.deletions ?? 0 };
};
