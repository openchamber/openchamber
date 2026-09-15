import type { Part } from '@opencode-ai/sdk/v2';

type TextLikePart = Part & { text?: string; content?: string };
type UserTextPart = Part & { text?: string; content?: string; shellAction?: { output?: unknown; command?: unknown } };

type MarkdownFence = {
    character: '`' | '~';
    length: number;
    contentIndent: number;
};

type MarkdownListItem = {
    markerIndent: number;
    contentIndent: number;
    codeIndent: number;
};

const getIndentWidth = (indentation: string): number => {
    let width = 0;
    for (const character of indentation) {
        width += character === '\t' ? 4 - (width % 4) : 1;
    }
    return width;
};

const FENCE_OPEN_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^([ \t]*)(`{3,}|~{3,})[ \t]*\r?$/;
const LIST_ITEM_RE = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+|$)/;
const THEMATIC_BREAK_RE = /^([ \t]*)(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BLOCK_BOUNDARY_RE = /^([ \t]*)(?:#{1,6}(?:[ \t]|$)|>[ \t]?)/;

const hasAtMostThreeColumnIndent = (indentation: string | undefined): boolean => (
    indentation !== undefined && getIndentWidth(indentation) <= 3
);

const getEnclosingContentIndent = (indent: number, listItems: MarkdownListItem[]): number => {
    for (let index = listItems.length - 1; index >= 0; index -= 1) {
        const listItem = listItems[index];
        if (listItem && indent >= listItem.contentIndent) return listItem.contentIndent;
    }
    return 0;
};

const getFence = (line: string, listItems: MarkdownListItem[]): MarkdownFence | null => {
    const match = line.match(FENCE_OPEN_RE);
    const indentation = match?.[1];
    const marker = match?.[2];
    if (indentation === undefined || !marker || (marker[0] === '`' && match[3]?.includes('`'))) {
        return null;
    }
    const character = marker[0];
    if (character !== '`' && character !== '~') return null;
    const indent = getIndentWidth(indentation);
    const contentIndent = getEnclosingContentIndent(indent, listItems);
    if (indent - contentIndent > 3) return null;
    return { character, length: marker.length, contentIndent };
};

const closesFence = (line: string, fence: MarkdownFence): boolean => {
    const match = line.match(FENCE_CLOSE_RE);
    const indentation = match?.[1];
    const marker = match?.[2];
    return Boolean(
        indentation !== undefined
        && getIndentWidth(indentation) - fence.contentIndent <= 3
        && marker
        && marker[0] === fence.character
        && marker.length >= fence.length,
    );
};

const isBlankLine = (line: string): boolean => /^\s*$/.test(line);

const getLineIndent = (line: string): number => getIndentWidth(line.match(/^[ \t]*/)?.[0] || '');

const isThematicBreak = (line: string): boolean => {
    const indentation = line.match(THEMATIC_BREAK_RE)?.[1];
    return hasAtMostThreeColumnIndent(indentation);
};

const isBlockBoundary = (line: string): boolean => {
    const indentation = line.match(BLOCK_BOUNDARY_RE)?.[1];
    return hasAtMostThreeColumnIndent(indentation);
};

const getListItem = (line: string): MarkdownListItem | null => {
    if (isThematicBreak(line)) return null;

    const match = line.match(LIST_ITEM_RE);
    const indentation = match?.[1];
    const marker = match?.[2];
    const spacing = match?.[3];
    if (indentation === undefined || !marker) return null;

    const markerIndent = getIndentWidth(indentation);
    const contentIndent = markerIndent + marker.length + getIndentWidth(spacing || ' ');
    return { markerIndent, contentIndent, codeIndent: contentIndent + 4 };
};

const isMarkdownBlockBoundary = (line: string, listItems: MarkdownListItem[]): boolean => (
    Boolean(getFence(line, listItems)) || isThematicBreak(line) || isBlockBoundary(line)
);

const getListContinuation = (
    line: string,
    listItems: MarkdownListItem[],
    hasPendingBlankLines: boolean,
): MarkdownListItem | null => {
    const indent = getLineIndent(line);
    for (let index = listItems.length - 1; index >= 0; index -= 1) {
        const listItem = listItems[index];
        if (!listItem || indent < listItem.contentIndent) continue;
        if (!hasPendingBlankLines || indent < listItem.codeIndent) return listItem;
    }
    return null;
};

const isValidListItem = (item: MarkdownListItem, listItems: MarkdownListItem[]): boolean => {
    let parentIndex = listItems.length - 1;
    while (parentIndex >= 0 && (listItems[parentIndex]?.markerIndent || 0) >= item.markerIndent) {
        parentIndex -= 1;
    }

    const parent = parentIndex >= 0 ? listItems[parentIndex] : undefined;
    return parent
        ? item.markerIndent >= parent.contentIndent && item.markerIndent < parent.codeIndent
        : item.markerIndent <= 3;
};

const updateListItems = (item: MarkdownListItem, listItems: MarkdownListItem[]): void => {
    let parentIndex = listItems.length - 1;
    while (parentIndex >= 0 && (listItems[parentIndex]?.markerIndent || 0) >= item.markerIndent) {
        parentIndex -= 1;
    }
    listItems.length = parentIndex + 1;
    listItems.push(item);
};

const isLazyListContinuation = (
    line: string,
    listItems: MarkdownListItem[],
    hasPendingBlankLines: boolean,
): boolean => {
    if (hasPendingBlankLines || listItems.length === 0 || isMarkdownBlockBoundary(line, listItems)) return false;
    const current = listItems[listItems.length - 1];
    return Boolean(current && getLineIndent(line) < current.contentIndent);
};

type MarkdownScannerState = {
    fence: MarkdownFence | null;
    indentedCodeIndent: number;
    listItems: MarkdownListItem[];
    pendingIndentedBlankLines: string[] | null;
    pendingIndentedBlankLineCount: number;
    pendingBlankLines: number;
};

type MarkdownLineScan = {
    kind: 'fence' | 'indented-code' | 'blank' | 'content';
    pendingIndentedBlankLines: string[];
    pendingBlankLines: number;
};

type MarkdownScannerMode = 'count' | 'normalize';

const createMarkdownScanner = (mode: MarkdownScannerMode) => {
    const retainLineDetails = mode === 'normalize';
    const state: MarkdownScannerState = {
        fence: null,
        indentedCodeIndent: 0,
        listItems: [],
        pendingIndentedBlankLines: retainLineDetails ? [] : null,
        pendingIndentedBlankLineCount: 0,
        pendingBlankLines: 0,
    };

    const scanLine = (line: string): MarkdownLineScan | undefined => {
        if (state.fence) {
            if (closesFence(line, state.fence)) state.fence = null;
            return retainLineDetails
                ? { kind: 'fence', pendingIndentedBlankLines: [], pendingBlankLines: 0 }
                : undefined;
        }

        if (state.indentedCodeIndent > 0) {
            if (getLineIndent(line) >= state.indentedCodeIndent) {
                const pendingIndentedBlankLines = state.pendingIndentedBlankLines;
                state.pendingIndentedBlankLines = retainLineDetails ? [] : null;
                state.pendingIndentedBlankLineCount = 0;
                return retainLineDetails
                    ? {
                        kind: 'indented-code',
                        pendingIndentedBlankLines: pendingIndentedBlankLines ?? [],
                        pendingBlankLines: 0,
                    }
                    : undefined;
            }

            if (isBlankLine(line)) {
                if (state.pendingIndentedBlankLines) {
                    state.pendingIndentedBlankLines.push(line);
                } else {
                    state.pendingIndentedBlankLineCount += 1;
                }
                return retainLineDetails
                    ? { kind: 'blank', pendingIndentedBlankLines: [], pendingBlankLines: 0 }
                    : undefined;
            }

            state.indentedCodeIndent = 0;
            state.pendingBlankLines += (
                state.pendingIndentedBlankLines?.length ?? state.pendingIndentedBlankLineCount
            );
            state.pendingIndentedBlankLines = retainLineDetails ? [] : null;
            state.pendingIndentedBlankLineCount = 0;
        }

        if (isBlankLine(line)) {
            state.pendingBlankLines += 1;
            return retainLineDetails
                ? { kind: 'blank', pendingIndentedBlankLines: [], pendingBlankLines: 0 }
                : undefined;
        }

        const hasPendingBlankLines = state.pendingBlankLines > 0;
        const listItem = getListItem(line);
        const validListItem = listItem ? isValidListItem(listItem, state.listItems) : false;
        const listContinuation = getListContinuation(line, state.listItems, hasPendingBlankLines);
        const isIndentedCode = getLineIndent(line) >= 4;
        const pendingBlankLines = state.pendingBlankLines;

        state.pendingBlankLines = 0;

        const nextFence = getFence(line, state.listItems);
        if (nextFence) {
            state.fence = nextFence;
        } else if (isIndentedCode && !validListItem && !listContinuation) {
            state.indentedCodeIndent = state.listItems[state.listItems.length - 1]?.codeIndent || 4;
        }

        if (validListItem && listItem) {
            updateListItems(listItem, state.listItems);
        } else if (
            !listContinuation
            && !isIndentedCode
            && !isLazyListContinuation(line, state.listItems, hasPendingBlankLines)
        ) {
            state.listItems.length = 0;
        }

        return retainLineDetails
            ? { kind: 'content', pendingIndentedBlankLines: [], pendingBlankLines }
            : undefined;
    };

    const isInsideCodeBlock = (): boolean => Boolean(state.fence || state.indentedCodeIndent);

    const isInsideCodeBlockAfterLine = (line: string): boolean => {
        const snapshot = {
            ...state,
            listItems: [...state.listItems],
            pendingIndentedBlankLines: state.pendingIndentedBlankLines ? [...state.pendingIndentedBlankLines] : null,
        };
        scanLine(line);
        const isInside = isInsideCodeBlock();
        state.fence = snapshot.fence;
        state.indentedCodeIndent = snapshot.indentedCodeIndent;
        state.listItems = snapshot.listItems;
        state.pendingIndentedBlankLines = snapshot.pendingIndentedBlankLines;
        state.pendingIndentedBlankLineCount = snapshot.pendingIndentedBlankLineCount;
        state.pendingBlankLines = snapshot.pendingBlankLines;
        return isInside;
    };

    return {
        scanLine,
        isInsideCodeBlock,
        isInsideCodeBlockAfterLine,
    };
};

const createIncrementalCodeBlockScanner = () => {
    const scanner = createMarkdownScanner('count');
    let currentLine = '';
    let pendingCarriageReturn = false;

    const endLine = (): void => {
        scanner.scanLine(currentLine);
        currentLine = '';
    };

    const append = (text: string): void => {
        let chunk = text;
        if (pendingCarriageReturn) {
            pendingCarriageReturn = false;
            endLine();
            if (chunk.startsWith('\n')) chunk = chunk.slice(1);
        }
        if (chunk.length === 0) return;
        if (chunk.endsWith('\r')) {
            pendingCarriageReturn = true;
            chunk = chunk.slice(0, -1);
        }

        const lines = chunk.replace(/\r\n?/g, '\n').split('\n');
        for (let index = 0; index < lines.length - 1; index += 1) {
            currentLine += lines[index];
            endLine();
        }
        currentLine += lines[lines.length - 1];
    };

    return {
        append,
        // Mirrors scanning the accumulated text, including a final line without a terminator.
        isInsideCodeBlock: (): boolean => (
            pendingCarriageReturn || currentLine.length > 0
                ? scanner.isInsideCodeBlockAfterLine(currentLine)
                : scanner.isInsideCodeBlock()
        ),
    };
};

const countBoundaryLineBreaks = (text: string, fromStart: boolean): number => {
    const match = fromStart
        ? text.match(/^[ \t]*(?:\r?\n[ \t]*)+/)
        : text.match(/(?:[ \t]*\r?\n)+[ \t]*$/);

    return match?.[0].match(/\r?\n/g)?.length || 0;
};

const joinTextParts = (textParts: string[]): string => {
    let joined = '';
    const codeBlockScanner = createIncrementalCodeBlockScanner();

    textParts.forEach((text, index) => {
        if (index === 0) {
            joined = text;
            codeBlockScanner.append(text);
            return;
        }

        const previousText = textParts[index - 1];
        const boundaryLineBreaks = countBoundaryLineBreaks(previousText, false)
            + countBoundaryLineBreaks(text, true);
        const desiredLineBreaks = codeBlockScanner.isInsideCodeBlock() ? 1 : 2;
        const separator = '\n'.repeat(Math.max(0, desiredLineBreaks - boundaryLineBreaks));
        const appendedText = `${separator}${text}`;
        joined += appendedText;
        codeBlockScanner.append(appendedText);
    });

    return joined;
};

const normalizeMarkdownBlankLines = (text: string): string => {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const normalized: string[] = [];
    const scanner = createMarkdownScanner('normalize');

    for (const line of lines) {
        const scan = scanner.scanLine(line);

        if (!scan) continue;

        if (scan.kind === 'fence') {
            normalized.push(line);
            continue;
        }

        if (scan.kind === 'indented-code') {
            normalized.push(...scan.pendingIndentedBlankLines, line);
            continue;
        }

        if (scan.kind === 'blank') continue;

        if (scan.pendingBlankLines > 0 && normalized.length > 0) normalized.push('');
        normalized.push(line);
    }

    return normalized.join('\n');
};

export const flattenAssistantTextParts = (parts: Part[]): string => {
    const textParts = parts
        .filter((part): part is TextLikePart => part?.type === 'text')
        .map((part) => part.text || part.content || '')
        .filter((text) => text.length > 0);

    const combined = joinTextParts(textParts);
    return normalizeMarkdownBlankLines(combined);
};

export const flattenUserTextParts = (parts: Part[]): string => {
    const textParts = parts.filter((part): part is UserTextPart => part?.type === 'text');

    const shellOutputs = textParts
        .map((part) => {
            const output = part.shellAction?.output;
            return typeof output === 'string' ? output.trim() : '';
        })
        .filter((output) => output.length > 0);
    if (shellOutputs.length > 0) {
        return shellOutputs.join('\n\n');
    }

    const shellCommands = textParts
        .map((part) => {
            const command = part.shellAction?.command;
            return typeof command === 'string' ? command.trim() : '';
        })
        .filter((command) => command.length > 0);
    if (shellCommands.length > 0) {
        return shellCommands.join('\n');
    }

    const plainTexts = textParts
        .map((part) => (part.text || part.content || '').trim())
        .filter((text) => text.length > 0);
    return plainTexts.join('\n\n');
};

export const suggestPlanTitleFromText = (text: string): string => {
    const normalized = text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0) || 'Plan';

    const cleaned = normalized
        .replace(/^#+\s*/, '')
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+\.\s+/, '');

    const sentenceMatch = cleaned.match(/(.+?[.!?])(?:\s|$)/);
    const firstSentence = sentenceMatch?.[1] || cleaned;
    const compact = firstSentence.replace(/\s+/g, ' ').trim();
    return compact.length > 160 ? compact.slice(0, 160).trim() : compact || 'Plan';
};
