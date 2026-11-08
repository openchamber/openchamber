import { isInvisibleText } from '@/lib/invisibleText';
import { readContextPart } from '@/lib/messages/contextParts';
import type { Part } from '@/lib/opencode/model';

const COLLAPSED_LINES = 2;

/**
 * The context parts a collapsed user message leaves out. The message gets two
 * lines: its own text takes what it needs and context rows get the rest, so
 * the text always stays. Session mentions draw no row and do not count.
 */
export const contextPartsPastCollapse = (parts: Part[], textLines: number): ReadonlySet<Part> => {
    const rows = parts.filter((part) => {
        const context = readContextPart(part);
        return context !== null && context.kind !== 'session' && context.kind !== 'session-message';
    });
    return new Set(rows.slice(Math.max(0, COLLAPSED_LINES - textLines)));
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

/**
 * The parts a message actually shows.
 *
 * OpenCode v2 no longer marks parts synthetic and no longer sends patch
 * parts, so the only choice left here is whether reasoning is on screen.
 */
export const filterVisibleParts = (parts: Part[], options: VisibleFilterOptions = {}): Part[] => {
    const { includeReasoning = true } = options;
    const validParts = normalizeParts(parts);
    if (includeReasoning) return validParts;
    return validParts.filter((part) => part.type !== 'reasoning');
};
