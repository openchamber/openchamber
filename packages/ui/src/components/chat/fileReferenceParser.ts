import { isAbsoluteFilePath, normalizeFilePath } from '@/lib/path-utils';

export type ParsedFileReference = {
    path: string;
    line?: number;
    column?: number;
    endLine?: number;
};

const KNOWN_FILE_BASENAMES = new Set([
    'dockerfile',
    'makefile',
    'readme',
    'license',
    '.env',
    '.gitignore',
    '.npmrc',
]);
const KNOWN_BASENAME_PATTERN = Array.from(KNOWN_FILE_BASENAMES)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

export const normalizeReferencePath = (value: string): string => normalizeFilePath(value);

export const isAbsoluteReferencePath = (value: string): boolean => isAbsoluteFilePath(value);

const trimPathCandidate = (value: string): string => {
    let next = (value || '').trim();
    if (!next) {
        return '';
    }

    if ((next.startsWith('`') && next.endsWith('`')) || (next.startsWith('"') && next.endsWith('"')) || (next.startsWith("'") && next.endsWith("'"))) {
        next = next.slice(1, -1).trim();
    }

    next = next.replace(/[.,;!?]+$/g, '');

    if (next.endsWith(')') && !next.includes('(')) {
        next = next.slice(0, -1);
    }
    if (next.endsWith(']') && !next.includes('[')) {
        next = next.slice(0, -1);
    }

    return next;
};

const stripTrailingReference = (value: string): string => {
    let next = trimPathCandidate(value);
    if (!next) {
        return '';
    }

    const semicolonIndex = next.indexOf(';');
    if (semicolonIndex >= 0) {
        next = next.slice(0, semicolonIndex);
    }

    next = next.replace(/#.*$/, '');

    const extensionSuffixMatch = next.match(/^(.*\.[A-Za-z0-9_-]{1,16}):.*$/);
    if (extensionSuffixMatch) {
        next = extensionSuffixMatch[1] ?? next;
    }

    const basenameSuffixMatch = KNOWN_BASENAME_PATTERN.length > 0
        ? next.match(new RegExp(`^(.*(?:/|^)(${KNOWN_BASENAME_PATTERN})):.*$`, 'i'))
        : null;
    if (basenameSuffixMatch) {
        next = basenameSuffixMatch[1] ?? next;
    }

    return trimPathCandidate(next);
};

export const parseFileReference = (value: string): ParsedFileReference | null => {
    const trimmed = trimPathCandidate(value);
    if (!trimmed) {
        return null;
    }

    const semicolonIndex = trimmed.indexOf(';');
    const withoutSemicolonSuffix = semicolonIndex >= 0
        ? trimPathCandidate(trimmed.slice(0, semicolonIndex))
        : trimmed;
    if (!withoutSemicolonSuffix) {
        return null;
    }

    // Range form: `path:start-end`. Tried before the colon form so a suffix
    // like `:10-20` is consumed as a range rather than truncated to a line
    // number. Range and col (`:line:col`) are mutually exclusive.
    const rangeMatch = withoutSemicolonSuffix.match(/^(.*?):(\d+)-(\d+)$/);
    if (rangeMatch) {
        const path = stripTrailingReference(rangeMatch[1] ?? '');
        const line = Number.parseInt(rangeMatch[2] ?? '', 10);
        const endLine = Number.parseInt(rangeMatch[3] ?? '', 10);
        if (!path || !Number.isFinite(line) || !Number.isFinite(endLine) || endLine < line) {
            return null;
        }

        return { path, line, endLine };
    }

    const hashMatch = withoutSemicolonSuffix.match(/^(.*)#L(\d+)(?:C(\d+))?$/i);
    if (hashMatch) {
        const path = stripTrailingReference(hashMatch[1] ?? '');
        const line = Number.parseInt(hashMatch[2] ?? '', 10);
        const column = hashMatch[3] ? Number.parseInt(hashMatch[3], 10) : undefined;
        if (!path || !Number.isFinite(line)) {
            return null;
        }

        return {
            path,
            line,
            column: Number.isFinite(column ?? Number.NaN) ? column : undefined,
        };
    }

    const colonMatch = withoutSemicolonSuffix.match(/^(.*?):(\d+)(?::(\d+))?$/);
    if (colonMatch) {
        const path = stripTrailingReference(colonMatch[1] ?? '');
        const line = Number.parseInt(colonMatch[2] ?? '', 10);
        const column = colonMatch[3] ? Number.parseInt(colonMatch[3], 10) : undefined;
        if (!path || !Number.isFinite(line)) {
            return null;
        }

        return {
            path,
            line,
            column: Number.isFinite(column ?? Number.NaN) ? column : undefined,
        };
    }

    const pathOnly = stripTrailingReference(withoutSemicolonSuffix);
    if (!pathOnly) {
        return null;
    }

    return { path: pathOnly };
};

// Matches `path[:line[:col]]` or `path:start-end` inside shell/grep-style
// output. Requires a file extension (1-8 alphanumerics) so plain words don't
// qualify; the path itself must contain at least one extension-bearing
// segment. The line suffix is either `:N`, `:N:M`, or `:N-M` (range); col and
// range are mutually exclusive.
//
// Known limitation: backslash-separated Windows paths (e.g.
// `C:\Users\test\file.ts:12`) are not matched because the path character class
// does not include `\`. Compiler output inside fenced code blocks predominantly
// uses forward slashes, so this is a niche gap. The inline-code pipeline is not
// affected — it reads full text content rather than matching with a regex.
export const BLOCK_PATH_TOKEN_RE = /(?:[A-Za-z]:[\\/])?[\w.\-/@+]*[\w\-/@+]\.[A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?(?::\d+)?)?/g;
