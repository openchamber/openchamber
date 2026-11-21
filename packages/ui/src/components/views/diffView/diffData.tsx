import { cn } from '@/lib/utils';
import { type GitStatus, type GitSubmoduleState } from '@/lib/api/types';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import { fileDiffFromPatch, isBinaryPatch } from '@/lib/diff/patchFileDiff';
import { parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs';
import { DiffCount } from '@/components/ui/diff-count';
import type { FileEntry, DiffContextMode, DiffData, ComparisonDiffResult } from './types';

export const EMPTY_COMPARISON_DIFF: ComparisonDiffResult = { status: 'loading' };
export const isNewStatusFile = (file: GitStatus['files'][number]): boolean => {
    const { index, working_dir: workingDir } = file;
    return index === 'A' || workingDir === 'A' || index === '?' || workingDir === '?';
};

export const isStagedStatusFile = (file: GitStatus['files'][number]): boolean => {
    const indexCode = file.index?.trim();
    return Boolean(indexCode && indexCode !== '?');
};

export const isWorkingStatusFile = (file: GitStatus['files'][number]): boolean => {
    const workingCode = file.working_dir?.trim();
    return Boolean(workingCode) || file.index === '?';
};

export const toAbsolutePath = (directory: string, filePath: string): string => {
    return toAbsoluteFilePath(directory, filePath);
};

export const getFirstChangedModifiedLine = (original: string, modified: string): number => {
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

export const createTextDiffDataFromPatch = (filePath: string, patch: string, contextMode: DiffContextMode): DiffData => {
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

export const diffDataToFileDiff = (
    filePath: string,
    data: { original: string; modified: string; isBinary?: boolean; submodule?: GitSubmoduleState | null; fileDiff?: FileDiffMetadata },
): FileDiffMetadata | null => {
    if (data.isBinary || data.submodule) return null;
    if (data.fileDiff) return data.fileDiff;
    if (!data.original && !data.modified) return null;
    return parseDiffFromFile({ name: filePath, contents: data.original }, { name: filePath, contents: data.modified });
};

const findPayloadIds = new WeakMap<ComparisonDiffResult | DiffData, number>();
let nextFindPayloadId = 0;
export const findPayloadRevision = (payload: ComparisonDiffResult | DiffData | undefined): string => {
    if (!payload) return 'absent';
    let id = findPayloadIds.get(payload);
    if (id === undefined) {
        nextFindPayloadId += 1;
        id = nextFindPayloadId;
        findPayloadIds.set(payload, id);
    }
    return String(id);
};

export const isFindRevealFor = (rowPath: string, key: string): boolean =>
    key === rowPath || (rowPath.endsWith('/') && key.startsWith(rowPath));

export const formatDiffTotals = (
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
            <DiffCount added={added} removed={removed} hideZero />
        </span>
    );
};
export const toNestedFileEntries = (status: GitStatus): FileEntry[] => status.files
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
