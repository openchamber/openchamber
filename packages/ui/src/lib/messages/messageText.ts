import type { Part } from '@opencode-ai/sdk/v2';

type TextLikePart = Part & { text?: string; content?: string };

export const flattenAssistantTextParts = (parts: Part[]): string => {
    const textParts = parts
        .filter((part): part is TextLikePart => part?.type === 'text')
        .map((part) => (part.text || part.content || '').trim())
        .filter((text) => text.length > 0);

    const combined = textParts.join('\n');
    return combined.replace(/\n\s*\n+/g, '\n');
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
