import type { Part } from "@opencode-ai/sdk/v2";

const extractTextFromDelta = (delta: unknown): string => {
    if (!delta) return '';
    if (typeof delta === 'string') return delta;
    if (Array.isArray(delta)) {
        return delta.map((item) => extractTextFromDelta(item)).join('');
    }
    if (typeof delta === 'object') {
        if (typeof (delta as { text?: unknown }).text === 'string') {
            return (delta as { text: string }).text;
        }
        if (Array.isArray((delta as { content?: unknown[] }).content)) {
            return (delta as { content: unknown[] }).content.map((item: unknown) => extractTextFromDelta(item)).join('');
        }
    }
    return '';
};

export const extractTextFromPart = (part: unknown): string => {
    if (!part) return '';
    const typedPart = part as { text?: string | unknown[]; delta?: unknown; content?: string | unknown[] };
    if (typeof typedPart.text === 'string') return typedPart.text;
    if (Array.isArray(typedPart.text)) {
        return typedPart.text.map((item: unknown) => (typeof item === 'string' ? item : extractTextFromPart(item))).join('');
    }
    const deltaText = extractTextFromDelta(typedPart.delta);
    if (deltaText) return deltaText;
    if (typeof typedPart.content === 'string') return typedPart.content;
    if (Array.isArray(typedPart.content)) {
        return typedPart.content
            .map((item: unknown) => {
                if (typeof item === 'string') return item;
                if (item && typeof item === 'object') {
                    const typedItem = item as { text?: string; delta?: unknown };
                    return typedItem.text || extractTextFromDelta(typedItem.delta) || '';
                }
                return '';
            })
            .join('');
    }
    return '';
};

export const normalizeStreamingPart = (incoming: Part, existing?: Part): Part => {
    const normalized: { type?: string; text?: string; content?: string; value?: string; delta?: unknown; [key: string]: unknown } = {
        ...incoming,
    } as { type?: string; text?: string; content?: string; value?: string; delta?: unknown; [key: string]: unknown };
    normalized.type = normalized.type || 'text';

    if (normalized.type === 'text') {
        const existingRecord = (existing ?? {}) as { text?: unknown; content?: unknown; value?: unknown };
        const existingText = extractTextFromPart(existing);
        const directText = extractTextFromPart(incoming);
        const deltaText = extractTextFromDelta((incoming as { delta?: unknown }).delta);
        let mergedText = '';

        if (directText) {
            if (!existingText) {
                mergedText = directText;
            } else if (directText.startsWith(existingText)) {
                mergedText = directText;
            } else if (existingText.endsWith(directText)) {
                mergedText = existingText;
            } else {
                mergedText = `${existingText}${directText}`;
            }
        } else if (deltaText) {
            mergedText = existingText ? `${existingText}${deltaText}` : deltaText;
        } else if (existingText) {
            mergedText = existingText;
        } else {
            mergedText = '';
        }

        const incomingField =
            typeof normalized.text === 'string'
                ? 'text'
                : typeof normalized.content === 'string'
                    ? 'content'
                    : typeof normalized.value === 'string'
                        ? 'value'
                        : null;

        const targetField = incomingField ?? (
            typeof existingRecord.text === 'string'
                ? 'text'
                : typeof existingRecord.content === 'string'
                    ? 'content'
                    : typeof existingRecord.value === 'string'
                        ? 'value'
                        : 'text'
        );

        normalized[targetField] = mergedText;
        if (targetField !== 'text') {
            normalized.text = mergedText;
        }

        delete normalized.delta;
    }

    return normalized as Part;
};
