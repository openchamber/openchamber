import { parsePatchFiles } from '@pierre/diffs';

export type DiffPatchEntry = {
    id: string;
    title: string;
    patch: string;
    renderMode: 'diff' | 'text';
};

const APPLY_PATCH_ENVELOPE_PATTERN = /^\*\*\*\s+(?:Begin Patch|End Patch|Add File:|Update File:|Delete File:|Move to:)/m;
const HUNK_HEADER_PATTERN = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m;
const GIT_DIFF_FILE_BREAK_PATTERN = /(?=^diff --git\s+)/gm;
const GIT_DIFF_FILE_BREAK_TEST = /^diff --git\s+/m;
const UNIFIED_DIFF_FILE_BREAK_PATTERN = /(?=^---\s+\S)/gm;
const UNIFIED_DIFF_FILE_BREAK_TEST = /^---\s+\S/m;

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

export const normalizePatchText = (patch: string): string => {
    return patch.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
};

export const getPatchText = (value: unknown): string | undefined => {
    if (typeof value === 'string') {
        return /\S/.test(value) ? value : undefined;
    }

    if (isRecord(value)) {
        const patch = value.patch;
        if (typeof patch === 'string') {
            return /\S/.test(patch) ? patch : undefined;
        }
    }

    return undefined;
};

const normalizeParsedPath = (path: string | undefined): string => {
    const trimmed = (path ?? '').trim().replace(/\t.*$/, '');
    if (!trimmed || trimmed === '/dev/null') {
        return '';
    }
    return trimmed.replace(/^[ab]\//, '');
};

const makeSyntheticPath = (title: string): string => {
    const normalized = title.trim().replace(/\s+/g, '-');
    return normalized.length > 0 ? normalized : 'file';
};

const hasOnlyUnifiedDiffBodyLines = (patch: string): boolean => {
    let inHunk = false;
    for (const line of patch.split('\n')) {
        if (line.startsWith('@@')) {
            if (!HUNK_HEADER_PATTERN.test(line)) {
                return false;
            }
            inHunk = true;
            continue;
        }

        if (!inHunk || line.length === 0) {
            continue;
        }

        const first = line[0];
        if (first !== ' ' && first !== '+' && first !== '-' && first !== '\\') {
            return false;
        }
    }

    return true;
};

export const getRenderablePatchInfo = (patch: string): { patch: string; title?: string } | null => {
    const normalized = normalizePatchText(patch);
    if (
        !normalized
        || APPLY_PATCH_ENVELOPE_PATTERN.test(normalized)
        || !HUNK_HEADER_PATTERN.test(normalized)
        || !hasOnlyUnifiedDiffBodyLines(normalized)
    ) {
        return null;
    }

    try {
        const parsedPatches = parsePatchFiles(normalized, undefined, true);
        if (parsedPatches.length !== 1) {
            return null;
        }

        const files = parsedPatches[0]?.files ?? [];
        const file = files[0];
        if (files.length !== 1 || !file || file.hunks.length === 0) {
            return null;
        }

        return {
            patch: normalized,
            title: normalizeParsedPath(file.name),
        };
    } catch {
        return null;
    }
};

const getPatchChunks = (patch: string): string[] => {
    const isGitDiff = GIT_DIFF_FILE_BREAK_TEST.test(patch);
    const hasUnifiedDiff = UNIFIED_DIFF_FILE_BREAK_TEST.test(patch);
    if (!isGitDiff && !hasUnifiedDiff) {
        return [];
    }

    return patch
        .split(isGitDiff ? GIT_DIFF_FILE_BREAK_PATTERN : UNIFIED_DIFF_FILE_BREAK_PATTERN)
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.length > 0);
};

const getPatchEntriesFromText = (
    patch: string,
    fallbackTitle: string,
    idPrefix: string,
    resolveTitle: (path: string) => string,
): DiffPatchEntry[] => {
    const normalized = normalizePatchText(patch);
    if (!normalized) {
        return [];
    }

    const direct = getRenderablePatchInfo(normalized);
    if (direct) {
        const title = direct.title ? resolveTitle(direct.title) : resolveTitle(fallbackTitle);
        return [{ id: `${idPrefix}-0`, title, patch: direct.patch, renderMode: 'diff' }];
    }

    const chunkEntries: DiffPatchEntry[] = [];
    for (const chunk of getPatchChunks(normalized)) {
        const info = getRenderablePatchInfo(chunk);
        const title = info?.title ? resolveTitle(info.title) : resolveTitle(fallbackTitle);
        if (!info) {
            if (HUNK_HEADER_PATTERN.test(chunk) || GIT_DIFF_FILE_BREAK_TEST.test(chunk) || UNIFIED_DIFF_FILE_BREAK_TEST.test(chunk)) {
                chunkEntries.push({
                    id: `${idPrefix}-${chunkEntries.length}`,
                    title,
                    patch: chunk,
                    renderMode: 'text',
                });
            }
            continue;
        }
        chunkEntries.push({
            id: `${idPrefix}-${chunkEntries.length}`,
            title,
            patch: info.patch,
            renderMode: 'diff',
        });
    }

    if (chunkEntries.length > 0) {
        return chunkEntries;
    }

    if (!APPLY_PATCH_ENVELOPE_PATTERN.test(normalized) && HUNK_HEADER_PATTERN.test(normalized)) {
        const syntheticPath = makeSyntheticPath(fallbackTitle);
        const synthetic = getRenderablePatchInfo(`--- ${syntheticPath}\n+++ ${syntheticPath}\n${normalized}`);
        if (synthetic) {
            return [{
                id: `${idPrefix}-0`,
                title: resolveTitle(fallbackTitle),
                patch: synthetic.patch,
                renderMode: 'diff',
            }];
        }
    }

    return [{
        id: `${idPrefix}-0`,
        title: resolveTitle(fallbackTitle),
        patch: normalized,
        renderMode: 'text',
    }];
};

const getFilePatch = (file: unknown): { patch: string; title: string } | null => {
    if (!isRecord(file)) {
        return null;
    }

    const patch = getPatchText(file.patch) ?? getPatchText(file.diff);
    if (!patch) {
        return null;
    }

    const rawPath = typeof file.relativePath === 'string'
        ? file.relativePath
        : typeof file.filePath === 'string'
            ? file.filePath
            : '';

    return {
        patch,
        title: rawPath,
    };
};

export const getDiffPatchEntries = (
    metadata: Record<string, unknown> | undefined,
    fallbackDiff: string | undefined,
    resolveTitle: (path: string) => string,
): DiffPatchEntry[] => {
    const files = Array.isArray(metadata?.files) ? metadata.files : [];
    const fileEntries = files.flatMap((file, index) => {
        const filePatch = getFilePatch(file);
        if (!filePatch) {
            return [];
        }
        return getPatchEntriesFromText(
            filePatch.patch,
            filePatch.title || `File ${index + 1}`,
            `file-${index}`,
            resolveTitle,
        );
    });

    if (fileEntries.length > 0) {
        return fileEntries;
    }

    const diff = typeof fallbackDiff === 'string' ? fallbackDiff : '';
    return getPatchEntriesFromText(diff, 'Diff', 'fallback', resolveTitle);
};
