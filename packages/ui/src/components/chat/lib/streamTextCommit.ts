
const HOLD_MAX_CHARS = 1500;
const LINE_HOLD_MAX_CHARS = 320;

const SENTENCE_END = /[.!?…][)"'»”’]?\s/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM_START = /^\s*(?:[-*+]|\d+[.)])\s/;
const HEADING = /^ {0,3}#{1,6}\s/;
const BOLD_TITLE = /^ {0,3}(?:\*\*|__)[^*_].*(?:\*\*|__):?\s*$/;

const isTitleLine = (line: string): boolean => HEADING.test(line) || BOLD_TITLE.test(line);

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
        const nextNewline = text.indexOf('\n', end);
        const next = text.slice(end, nextNewline === -1 ? undefined : nextNewline);
        if (LIST_ITEM_START.test(next) || HEADING.test(next)) {
            closeBlock(end);
        }
    }
    return ends;
};

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
    while (index >= 0 && ends[index].title) index -= 1;
    const committed = index >= 0 ? ends[index].end : 0;

    if (text.length - committed <= HOLD_MAX_CHARS) {
        return text.slice(0, committed);
    }
    return commitStreamedLines(text);
};
