
import { isFenceClose, matchFenceOpen } from '../composerHighlight';

export function appendWithLineBreaks(base: string, next: string): string {
    const separator = !base
        ? ''
        : base.endsWith('\n\n')
            ? ''
            : base.endsWith('\n')
                ? '\n'
                : '\n\n';

    const nextWithTrailingBreaks = next.endsWith('\n\n')
        ? next
        : next.endsWith('\n')
            ? `${next}\n`
            : `${next}\n\n`;

    return `${base}${separator}${nextWithTrailingBreaks}`;
}

export function appendInlineText(base: string, next: string): string {
    const nextTrimmed = next.trim();
    if (!nextTrimmed) {
        return base;
    }
    if (!base) {
        return `${nextTrimmed} `;
    }
    const separator = /[\s\n]$/.test(base) ? '' : ' ';
    return `${base}${separator}${nextTrimmed} `;
}

export function withLeadingSlashCommand(base: string, name: string): string {
    const draft = base.trimStart();
    const command = `/${name}`;
    if (draft === command) return `${command} `;
    if (draft.startsWith(command) && /\s/.test(draft[command.length] ?? '')) return base;
    return `${command} ${draft}`;
}

export function withInlineInsertionBoundaries(
    content: string,
    before: string,
    after: string,
): string {
    if (!content) {
        return content;
    }

    const needsLeadingSpace = before.length > 0
        && !/\s$/.test(before)
        && !/^\s/.test(content)
        && !/[([{]$/.test(before);
    const needsTrailingSpace = after.length > 0
        && !/\s$/.test(content)
        && !/^\s/.test(after)
        && !/^[\])}.,;:!?]/.test(after);

    return `${needsLeadingSpace ? ' ' : ''}${content}${needsTrailingSpace ? ' ' : ''}`;
}

export function buildImagePasteInsertion(pastedText: string, citationText: string): string {
    if (!pastedText) {
        return citationText;
    }
    return `${pastedText}${/\s$/.test(pastedText) ? '' : ' '}${citationText}`;
}

const PASTE_LINK_URL_PATTERN = /^(https?:\/\/|mailto:)\S+$/i;

export function shouldWrapSelectionAsLink(url: string, selected: string): boolean {
    return PASTE_LINK_URL_PATTERN.test(url)
        && !/\s/.test(url)
        && selected.trim().length > 0
        && !selected.includes('](');
}

const MARKDOWN_WRAP_PAIRS: Record<string, [string, string]> = {
    '`': ['`', '`'],
    '*': ['*', '*'],
    '_': ['_', '_'],
    '~': ['~', '~'],
    '(': ['(', ')'],
    '[': ['[', ']'],
    '{': ['{', '}'],
    '"': ['"', '"'],
    "'": ["'", "'"],
};

export function getMarkdownAutoPairEdit(
    value: string,
    key: string,
    selectionStart: number,
    selectionEnd: number,
): {
    from: number;
    to: number;
    insert: string;
    selectionStart: number;
    selectionEnd: number;
} | null {
    const pair = MARKDOWN_WRAP_PAIRS[key];
    if (selectionEnd > selectionStart && pair) {
        const selected = value.slice(selectionStart, selectionEnd);
        const [open, close] = pair;
        return {
            from: selectionStart,
            to: selectionEnd,
            insert: `${open}${selected}${close}`,
            selectionStart: selectionStart + open.length,
            selectionEnd: selectionEnd + open.length,
        };
    }

    if (key === '`' && selectionStart === selectionEnd) {
        const before = value.slice(0, selectionStart);
        if (/(^|\n)``$/.test(before)) {
            return {
                from: selectionStart,
                to: selectionEnd,
                insert: '`\n\n```',
                selectionStart: selectionStart + 2,
                selectionEnd: selectionStart + 2,
            };
        }
    }

    return null;
}

const ORDERED_LIST_MARKER = /^([ \t]*)(\d+)([.)])(?:[ \t]+(.*))?$/;

function isInsideFencedCode(value: string, lineStart: number): boolean {
    let openMarker: string | null = null;
    for (const line of value.slice(0, lineStart).split('\n')) {
        if (openMarker !== null) {
            if (isFenceClose(line, openMarker)) {
                openMarker = null;
            }
            continue;
        }
        openMarker = matchFenceOpen(line)?.marker ?? null;
    }
    return openMarker !== null;
}

export function getOrderedListContinuationEdit(
    value: string,
    selectionStart: number,
    selectionEnd: number,
): {
    from: number;
    to: number;
    insert: string;
    selectionStart: number;
    selectionEnd: number;
} | null {
    if (selectionStart !== selectionEnd) {
        return null;
    }

    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
    const lineBreak = value.indexOf('\n', selectionStart);
    const lineEnd = lineBreak === -1 ? value.length : lineBreak;
    if (selectionStart !== lineEnd) {
        return null;
    }

    const match = ORDERED_LIST_MARKER.exec(value.slice(lineStart, lineEnd));
    if (!match) {
        return null;
    }

    const number = Number(match[2]);
    if (!Number.isSafeInteger(number) || isInsideFencedCode(value, lineStart)) {
        return null;
    }

    if (!match[4]) {
        return {
            from: lineStart,
            to: lineEnd,
            insert: '',
            selectionStart: lineStart,
            selectionEnd: lineStart,
        };
    }

    const insert = `\n${match[1]}${number + 1}${match[3]} `;
    return {
        from: selectionStart,
        to: selectionStart,
        insert,
        selectionStart: selectionStart + insert.length,
        selectionEnd: selectionStart + insert.length,
    };
}
