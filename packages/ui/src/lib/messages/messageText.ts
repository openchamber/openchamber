import type { Part } from '@opencode-ai/sdk/v2';

type TextLikePart = Part & { text?: string; content?: string };

type MarkdownFence = {
    character: '`' | '~';
    length: number;
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

const getFence = (line: string): MarkdownFence | null => {
    const match = line.match(FENCE_OPEN_RE);
    const indentation = match?.[1];
    const marker = match?.[2];
    if (!hasAtMostThreeColumnIndent(indentation) || !marker || (marker[0] === '`' && match[3]?.includes('`'))) {
        return null;
    }
    const character = marker[0];
    if (character !== '`' && character !== '~') return null;
    return { character, length: marker.length };
};

const closesFence = (line: string, fence: MarkdownFence): boolean => {
    const match = line.match(FENCE_CLOSE_RE);
    const indentation = match?.[1];
    const marker = match?.[2];
    return Boolean(
        hasAtMostThreeColumnIndent(indentation)
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

const isMarkdownBlockBoundary = (line: string): boolean => (
    Boolean(getFence(line)) || isThematicBreak(line) || isBlockBoundary(line)
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
    if (hasPendingBlankLines || listItems.length === 0 || isMarkdownBlockBoundary(line)) return false;
    const current = listItems[listItems.length - 1];
    return Boolean(current && getLineIndent(line) < current.contentIndent);
};

const countBoundaryLineBreaks = (text: string, fromStart: boolean): number => {
    const match = fromStart
        ? text.match(/^[ \t]*(?:\r?\n[ \t]*)+/)
        : text.match(/(?:[ \t]*\r?\n)+[ \t]*$/);

    return match?.[0].match(/\r?\n/g)?.length || 0;
};

const joinTextParts = (textParts: string[]): string => textParts
    .map((text, index) => {
        if (index === 0) return text;

        const previousText = textParts[index - 1];
        const boundaryLineBreaks = countBoundaryLineBreaks(previousText, false)
            + countBoundaryLineBreaks(text, true);
        const separator = '\n'.repeat(Math.max(0, 2 - boundaryLineBreaks));
        return `${separator}${text}`;
    })
    .join('');

const normalizeMarkdownBlankLines = (text: string): string => {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const normalized: string[] = [];
    let fence: MarkdownFence | null = null;
    let inIndentedCode = false;
    let indentedCodeIndent = 0;
    const listItems: MarkdownListItem[] = [];
    let pendingIndentedBlankLines: string[] = [];
    let pendingBlankLines = 0;

    const flushPendingBlankLines = (): void => {
        if (pendingBlankLines > 0 && normalized.length > 0) normalized.push('');
        pendingBlankLines = 0;
    };

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];

        if (fence) {
            normalized.push(line);
            if (closesFence(line, fence)) fence = null;
            continue;
        }

        if (inIndentedCode) {
            if (getLineIndent(line) >= indentedCodeIndent) {
                normalized.push(...pendingIndentedBlankLines);
                pendingIndentedBlankLines = [];
                normalized.push(line);
                continue;
            }

            if (isBlankLine(line)) {
                pendingIndentedBlankLines.push(line);
                continue;
            }

            inIndentedCode = false;
            indentedCodeIndent = 0;
            pendingBlankLines += pendingIndentedBlankLines.length;
            pendingIndentedBlankLines = [];
        }

        if (isBlankLine(line)) {
            pendingBlankLines += 1;
            continue;
        }

        const hasPendingBlankLines = pendingBlankLines > 0;
        const listItem = getListItem(line);
        const validListItem = listItem ? isValidListItem(listItem, listItems) : false;
        const listContinuation = getListContinuation(line, listItems, hasPendingBlankLines);
        const isIndentedCode = getLineIndent(line) >= 4;

        flushPendingBlankLines();
        normalized.push(line);

        const nextFence = getFence(line);
        if (nextFence) {
            fence = nextFence;
        } else if (isIndentedCode && !validListItem && !listContinuation) {
            inIndentedCode = true;
            indentedCodeIndent = listItems[listItems.length - 1]?.codeIndent || 4;
        }

        if (validListItem && listItem) {
            updateListItems(listItem, listItems);
        } else if (
            !listContinuation
            && !isIndentedCode
            && !isLazyListContinuation(line, listItems, hasPendingBlankLines)
        ) {
            listItems.length = 0;
        }
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
