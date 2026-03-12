import type { Part } from '@opencode-ai/sdk/v2';

const shouldKeepSyntheticUserText = (text: string): boolean => {
    const trimmed = text.trim();
    if (trimmed.startsWith('User has requested to enter plan mode')) return true;
    if (trimmed.startsWith('The plan at ')) return true;
    if (trimmed.startsWith('The following tool was executed by the user')) return true;
    return false;
};

export const normalizeUserDisplayParts = (parts: Part[]): Part[] => {
    return parts
        .filter((part) => {
            const synthetic = (part as { synthetic?: boolean }).synthetic === true;
            if (!synthetic) return true;
            if (part.type !== 'text') return false;
            const text = (part as { text?: unknown }).text;
            return typeof text === 'string' ? shouldKeepSyntheticUserText(text) : false;
        })
        .map((part) => {
            const rawPart = part as Record<string, unknown>;
            if (rawPart.type === 'compaction') {
                return { type: 'text', text: '/compact' } as Part;
            }
            if (rawPart.type === 'text') {
                const text = typeof rawPart.text === 'string' ? rawPart.text.trim() : '';
                if (text.startsWith('The following tool was executed by the user')) {
                    return { type: 'text', text: '/shell' } as Part;
                }
            }
            return part;
        });
};
