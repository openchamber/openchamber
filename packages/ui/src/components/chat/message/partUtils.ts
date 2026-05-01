import type { Part } from '@opencode-ai/sdk/v2';

type PartWithText = Part & { text?: string; content?: string; value?: string };

export const isValidPart = (part: unknown): part is Part => {
    return Boolean(part && typeof part === 'object' && typeof (part as { type?: unknown }).type === 'string');
};

export const normalizeParts = (parts: Part[]): Part[] => {
    return parts.filter(isValidPart);
};

export const extractTextContent = (part: Part): string => {
    const partWithText = part as PartWithText;
    const rawText = partWithText.text;
    if (typeof rawText === 'string') {
        return rawText;
    }
    return partWithText.content || partWithText.value || '';
};

export const isEmptyTextPart = (part: Part): boolean => {
    if (part.type !== 'text') {
        return false;
    }
    const text = extractTextContent(part);
    return !text || text.trim().length === 0;
};

type PartWithSynthetic = Part & { synthetic?: boolean };

interface VisibleFilterOptions {
    includeReasoning?: boolean;
}

export const filterVisibleParts = (parts: Part[], options: VisibleFilterOptions = {}): Part[] => {
    const { includeReasoning = true } = options;
    const validParts = normalizeParts(parts);

    // Check if there are any non-synthetic parts
    const hasNonSynthetic = validParts.some((part) => {
        const partWithSynthetic = part as PartWithSynthetic;
        return !partWithSynthetic.synthetic;
    });

    return validParts.filter((part) => {
        const partWithSynthetic = part as PartWithSynthetic;
        const isSynthetic = Boolean(partWithSynthetic.synthetic);

        if (isSynthetic && part.type === 'text') {
            const text = extractTextContent(part);
            if (text.includes('<system-reminder>')) {
                return false;
            }
        }

        // Only filter out synthetic parts if there are non-synthetic parts present
        // Otherwise, show synthetic parts so the message is displayed
        if (isSynthetic && hasNonSynthetic) {
            return false;
        }
        if (!includeReasoning && part.type === 'reasoning') {
            return false;
        }
        const isPatchPart = part.type === 'patch';

        return !isPatchPart;
    });
};

type PartWithTime = Part & { time?: { start?: number; end?: number } };

export const isFinalizedTextPart = (part: Part): boolean => {
    if (part.type !== 'text') {
        return false;
    }
    const time = (part as PartWithTime).time;
    return Boolean(time && typeof time.end !== 'undefined');
};
