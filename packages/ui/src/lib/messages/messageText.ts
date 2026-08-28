import type { Part } from '@opencode-ai/sdk/v2';

type TextLikePart = Part & { text?: string; content?: string };
type UserTextPart = Part & { text?: string; content?: string; shellAction?: { output?: unknown; command?: unknown } };

export const flattenAssistantTextParts = (parts: Part[]): string => {
    const textParts = parts
        .filter((part): part is TextLikePart => part?.type === 'text')
        .map((part) => (part.text || part.content || '').trim())
        .filter((text) => text.length > 0);

    return textParts.join('\n\n');
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
