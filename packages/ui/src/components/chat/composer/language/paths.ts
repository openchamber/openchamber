/**
 * `~path` — a path written for the reader, not for the machine.
 *
 * `@path` attaches a file: it resolves against the project, searches, and rides
 * along with the message. Often that is not what is wanted. Explaining where
 * something lives, or naming a file in another repository, should not silently
 * attach it — but it should still stand out from prose, because a path buried
 * in a sentence is hard to read.
 *
 * `~` marks exactly that: **highlighting without attachment**. It is inert by
 * design, so nothing here feeds the autocomplete or the send path.
 *
 * @see mentions.ts for `@`, which does attach.
 */

import type { HighlightRange } from '../../composerHighlight';

/**
 * A path token: `~` followed by non-whitespace. The same trailing punctuation
 * rule as mentions applies, so `see ~src/app.ts,` marks the path and leaves
 * the comma to the sentence.
 */
const PATH_SCAN = /~([^\s~]+)/g;
const TRAILING_NOISE = /[)\]},.;:!?`"'>]+$/;

/**
 * `~` opens a path only at a token boundary. Inside a word it is arithmetic,
 * an approximation, or part of an identifier.
 */
const BOUNDARY_BEFORE = /[\s()[\]{}<>"'`,;:]/;

export interface PathToken {
    /** Offset of the `~`. */
    start: number;
    /** Offset just past the path. */
    end: number;
    /** The path without its `~`. */
    path: string;
}

/**
 * True when the token looks like a path rather than a stray word. A separator
 * or a file extension is required, so `~approximately` stays prose while
 * `~/repos/ocb` and `~README.md` are paths.
 *
 * The extension must begin with a letter. `~` also reads as "about" in front
 * of a number, and `~1.2 seconds` is far more likely to be prose than a file.
 */
function looksLikePath(value: string): boolean {
    return value.includes('/') || value.includes('\\') || /\.[A-Za-z]/.test(value);
}

/**
 * Find every `~path` in `text`.
 *
 * Deliberately blind to `~~strikethrough~~` and to `~~~` code fences: the scan
 * stops at `~`, so a doubled marker yields nothing to highlight and the fence
 * tokenizer keeps its own text.
 */
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

/** Path tokens as highlight ranges. */
export function pathHighlightRanges(text: string): HighlightRange[] {
    return scanPaths(text).map((token) => ({
        start: token.start,
        end: token.end,
        style: 'path' as const,
    }));
}
