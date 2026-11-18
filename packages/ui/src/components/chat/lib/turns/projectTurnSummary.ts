import { isInvisibleText } from '@/lib/invisibleText';
import { summarizeLiveActivity } from './liveActivitySummary';
import type { ChatMessageEntry, TurnChangedFile, TurnSummaryRecord } from './types';

const getTextFromPart = (part: unknown): string | undefined => {
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string' && !isInvisibleText(text)) {
        return text;
    }
    const content = (part as { content?: unknown }).content;
    if (typeof content === 'string' && !isInvisibleText(content)) {
        return content;
    }
    return undefined;
};

export const projectTurnSummary = (assistantMessages: ChatMessageEntry[]): TurnSummaryRecord => {
    for (let messageIndex = assistantMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const assistantMessage = assistantMessages[messageIndex];
        if (!assistantMessage) continue;

        const finish = (assistantMessage.info as { finish?: string | null }).finish;
        if (finish !== 'stop') continue;

        for (let partIndex = assistantMessage.parts.length - 1; partIndex >= 0; partIndex -= 1) {
            const part = assistantMessage.parts[partIndex];
            if (!part || part.type !== 'text') continue;

            const text = getTextFromPart(part);
            if (!text) continue;

            return {
                text,
                sourceMessageId: assistantMessage.info.id,
                sourcePartId: part.id ?? `${assistantMessage.info.id}-part-${partIndex}-text`,
            };
        }
    }

    for (let messageIndex = assistantMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const assistantMessage = assistantMessages[messageIndex];
        if (!assistantMessage) continue;

        for (let partIndex = assistantMessage.parts.length - 1; partIndex >= 0; partIndex -= 1) {
            const part = assistantMessage.parts[partIndex];
            if (!part || part.type !== 'text') continue;

            const text = getTextFromPart(part);
            if (!text) continue;

            return {
                text,
                sourceMessageId: assistantMessage.info.id,
                sourcePartId: part.id ?? `${assistantMessage.info.id}-part-${partIndex}-text`,
            };
        }
    }

    return {};
};

export const projectTurnChangedFiles = (
    assistantMessages: ChatMessageEntry[],
): TurnChangedFile[] | undefined => {
    const summary = summarizeLiveActivity(assistantMessages);

    const files = summary.changedFiles.map((change): TurnChangedFile => (
        change.additions !== undefined && change.deletions !== undefined
            ? { file: change.path, additions: change.additions, deletions: change.deletions, inTurnDiff: true }
            : { file: change.path, inTurnDiff: true }
    ));

    return files.length > 0 ? files : undefined;
};
