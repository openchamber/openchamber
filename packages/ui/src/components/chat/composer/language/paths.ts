
import type { HighlightRange } from '../../composerHighlight';

const PATH_SCAN = /~([^\s~]+)/g;
const TRAILING_NOISE = /[)\]},.;:!?`"'>]+$/;

const BOUNDARY_BEFORE = /[\s()[\]{}<>"'`,;:]/;

export interface PathToken {
    start: number;
    end: number;
    path: string;
}

function looksLikePath(value: string): boolean {
    return value.includes('/') || value.includes('\\') || /\.[A-Za-z]/.test(value);
}

export function scanPaths(text: string): PathToken[] {
    if (!text || !text.includes('~')) return [];

    const tokens: PathToken[] = [];
    PATH_SCAN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = PATH_SCAN.exec(text)) !== null) {
        const start = match.index;
        const before = start > 0 ? text[start - 1] : '';
        if (before && !BOUNDARY_BEFORE.test(before)) continue;

        const path = (match[1] ?? '').replace(TRAILING_NOISE, '');
        if (!path || !looksLikePath(path)) continue;

        tokens.push({ start, end: start + 1 + path.length, path });
    }

    return tokens;
}

export function pathHighlightRanges(text: string): HighlightRange[] {
    return scanPaths(text).map((token) => ({
        start: token.start,
        end: token.end,
        style: 'path' as const,
    }));
}
