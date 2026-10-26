// Block-level streaming reveal.
//
// Token-by-token streaming mutates the trailing paragraph in place on every
// tick: words rewrap, the last line jitters, and the reader's eye fights the
// motion. Text is committed only up to the end of the last finished block, so
// every rendered block is immutable once it appears and the reply lands a
// block at a time: a paragraph, a list item, a closed code fence, a table. A
// block ends at a blank line, at a closing fence, or right before a line that
// starts a list item or a heading. A heading or a bold-only title line is held
// until the block after it is finished too, so a title never shows alone, and
// a line still being written never shows at all.
//
// A block that runs on for a long stretch (a long fence, a paragraph with no
// break) must not stall the stream, so once the held tail outgrows a
// threshold the reveal falls back to complete lines, and inside a long line
// to the last sentence or word boundary.

const HOLD_MAX_CHARS = 1500;
const LINE_HOLD_MAX_CHARS = 320;

const SENTENCE_END = /[.!?…][)"'»”’]?\s/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM_START = /^\s*(?:[-*+]|\d+[.)])\s/;
const HEADING = /^ {0,3}#{1,6}\s/;
const BOLD_TITLE = /^ {0,3}(?:\*\*|__)[^*_].*(?:\*\*|__):?\s*$/;

const isTitleLine = (line: string): boolean => HEADING.test(line) || BOLD_TITLE.test(line);

/**
 * Offsets where a finished block ends, in order, counting only complete
 * lines. Each entry also records whether that block is a lone title line.
 */
const findBlockEnds = (text: string): Array<{ end: number; title: boolean }> => {
    const ends: Array<{ end: number; title: boolean }> = [];
    let fence: { char: string; length: number } | null = null;
    let blockLines: string[] = [];
    let start = 0;

    const closeBlock = (end: number) => {
        const content = blockLines.filter((line) => line.trim().length > 0);
        if (content.length > 0) {
            ends.push({ end, title: content.length === 1 && isTitleLine(content[0]) });
        }
        blockLines = [];
    };

    while (start < text.length) {
        const newline = text.indexOf('\n', start);
        if (newline === -1) break;
        const line = text.slice(start, newline);
        const end = newline + 1;
        start = end;

        const marker = FENCE.exec(line)?.[1];
        if (fence) {
            blockLines.push(line);
            if (marker && marker[0] === fence.char && marker.length >= fence.length && line.trim() === marker) {
                fence = null;
                closeBlock(end);
            }
            continue;
        }
        if (marker) {
            fence = { char: marker[0], length: marker.length };
            blockLines.push(line);
            continue;
        }
        if (line.trim().length === 0) {
            closeBlock(end);
            continue;
        }
        blockLines.push(line);
        // The next line starts a new block: the one written so far is done.
        // Its first characters are enough, it need not be finished.
        const nextNewline = text.indexOf('\n', end);
        const next = text.slice(end, nextNewline === -1 ? undefined : nextNewline);
        if (LIST_ITEM_START.test(next) || HEADING.test(next)) {
            closeBlock(end);
        }
    }
    return ends;
};

/** The prefix up to the last complete line, released at a sentence or word inside a long line. */
const commitStreamedLines = (text: string): string => {
    const lastNewline = text.lastIndexOf('\n');
    const committed = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
    const held = text.slice(committed.length);

    if (held.length <= LINE_HOLD_MAX_CHARS) {
        return committed;
    }

    let lastSentenceEnd = -1;
    for (const match of held.matchAll(SENTENCE_END)) {
        lastSentenceEnd = match.index + match[0].length;
    }
    if (lastSentenceEnd > 0) {
        return committed + held.slice(0, lastSentenceEnd);
    }

    // No sentence boundary either (a URL, a very long token run): release up
    // to the last word boundary, keeping only the incomplete word held.
    const lastSpace = held.lastIndexOf(' ');
    if (lastSpace > 0) {
        return committed + held.slice(0, lastSpace + 1);
    }

    return text;
};

export const commitStreamedText = (text: string): string => {
    if (text.length === 0) return text;

    const ends = findBlockEnds(text);
    let index = ends.length - 1;
    // A title waits for the block it introduces.
    while (index >= 0 && ends[index].title) index -= 1;
    const committed = index >= 0 ? ends[index].end : 0;

    if (text.length - committed <= HOLD_MAX_CHARS) {
        return text.slice(0, committed);
    }
    return commitStreamedLines(text);
};
