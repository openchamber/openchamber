import { isInvisibleText } from '@/lib/invisibleText';
import { readBrowserAnnotationPrompt } from '@/lib/browser/annotationPrompt';
import { readContextPart } from '@/lib/messages/contextParts';
import type { Part } from '@/lib/opencode/model';

const COLLAPSED_LINES = 2;

export const contextPartsPastCollapse = (parts: Part[], textLines: number): ReadonlySet<Part> => {
    const rows: Array<{ part: Part; lines: number; collapses: boolean }> = [];
    for (const part of parts) {
        const context = readContextPart(part);
        if (context === null || context.kind === 'session' || context.kind === 'session-message') continue;
        const comment = context.kind === 'browser-annotation'
            ? context.text || readBrowserAnnotationPrompt(context.prompt).comment || ''
            : 'text' in context ? context.text : '';
        rows.push({
            part,
            lines: comment.trim().length > 0 ? 2 : 1,
            // A shared page draws a whole card and ignores the collapse, so it
            // has no one-line form to stand in for.
            collapses: context.kind !== 'shared-page',
        });
    }

    // Rows fill the budget from the top: what fits shows, the rest waits behind
    // show more.
    let fits = 0;
    let linesLeft = COLLAPSED_LINES - textLines;
    while (fits < rows.length && rows[fits].lines <= linesLeft) {
        linesLeft -= rows[fits].lines;
        fits += 1;
    }

    // The typed text can take the whole budget and leave an attached quote
    // reachable only behind show more. When not even the first row fits, that
    // row is kept anyway, whatever it needs: a quote with a comment is a
    // two-line row, and keeping only one-line rows left the reported case
    // invisible. A shared page is still never kept; its card draws several
    // lines and ignores the collapse.
    const kept = fits === 0 ? rows.findIndex((row) => row.collapses) : -1;

    const hidden = new Set<Part>();
    rows.forEach((row, index) => {
        if (index < fits || index === kept) return;
        hidden.add(row.part);
    });
    return hidden;
};

const isValidPart = (part: unknown): part is Part => {
    return Boolean(part && typeof part === 'object' && typeof (part as { type?: unknown }).type === 'string');
};

export const normalizeParts = (parts: Part[]): Part[] => {
    return parts.filter(isValidPart);
};

export const extractTextContent = (part: Part): string => {
    return part.type === 'text' || part.type === 'reasoning' ? part.text : '';
};

export const isEmptyTextPart = (part: Part): boolean => {
    if (part.type !== 'text') {
        return false;
    }
    return isInvisibleText(part.text);
};

interface VisibleFilterOptions {
    includeReasoning?: boolean;
}

export const filterVisibleParts = (parts: Part[], options: VisibleFilterOptions = {}): Part[] => {
    const { includeReasoning = true } = options;
    const validParts = normalizeParts(parts);
    if (includeReasoning) return validParts;
    return validParts.filter((part) => part.type !== 'reasoning');
};
