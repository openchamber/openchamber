import { isInvisibleText } from '@/lib/invisibleText';
import { readBrowserAnnotationPrompt } from '@/lib/browser/annotationPrompt';
import { readContextPart } from '@/lib/messages/contextParts';
import type { Part } from '@/lib/opencode/model';

const COLLAPSED_LINES = 2;

/**
 * The context parts a collapsed user message leaves out. The message gets two
 * lines: its own text takes what it needs and context items get the rest, so
 * the text always stays. A collapsed item is its quote line, plus a line for
 * the user's comment when there is one; an item that does not fit whole is
 * left out with everything after it. Session mentions draw no row and do not
 * count.
 */
export const contextPartsPastCollapse = (parts: Part[], textLines: number): ReadonlySet<Part> => {
    const hidden = new Set<Part>();
    let linesLeft = COLLAPSED_LINES - textLines;
    for (const part of parts) {
        const context = readContextPart(part);
        if (context === null || context.kind === 'session' || context.kind === 'session-message') continue;
        // An older annotation keeps its comment inside the prompt, and the card shows it all the same.
        const comment = context.kind === 'browser-annotation'
            ? context.text || readBrowserAnnotationPrompt(context.prompt).comment || ''
            : 'text' in context ? context.text : '';
        const lines = comment.trim().length > 0 ? 2 : 1;
        if (hidden.size === 0 && lines <= linesLeft) {
            linesLeft -= lines;
        } else {
            hidden.add(part);
        }
    }
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
