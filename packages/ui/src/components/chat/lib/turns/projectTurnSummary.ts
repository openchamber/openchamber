import { summarizeLiveActivity } from './liveActivitySummary';
import type { ChatMessageEntry, TurnChangedFile, TurnDiffStats, TurnSummaryRecord } from './types';

const getTextFromPart = (part: unknown): string | undefined => {
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string' && text.trim().length > 0) {
        return text;
    }
    const content = (part as { content?: unknown }).content;
    if (typeof content === 'string' && content.trim().length > 0) {
        return content;
    }
    return undefined;
};

const isCompactionSummaryMessage = (message: ChatMessageEntry): boolean => {
    return (message.info as { summary?: unknown }).summary === true;
};

export const projectTurnSummary = (assistantMessages: ChatMessageEntry[]): TurnSummaryRecord => {
    for (let messageIndex = assistantMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const assistantMessage = assistantMessages[messageIndex];
        if (!assistantMessage) continue;
        if (isCompactionSummaryMessage(assistantMessage)) continue;

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
        if (isCompactionSummaryMessage(assistantMessage)) continue;

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

/**
 * "+N −M across F files" for a turn, summed from the edits the turn itself
 * made. v1 read these numbers off a working-tree snapshot on the user
 * message; v2 has none, so the tool-call patches are the source, and a file
 * whose patch carried no line counts contributes only to the file count.
 */
export const projectTurnDiffStats = (changedFiles: TurnChangedFile[] | undefined): TurnDiffStats | undefined => {
    if (!changedFiles || changedFiles.length === 0) {
        return undefined;
    }

    let additions = 0;
    let deletions = 0;

    for (const change of changedFiles) {
        additions += change.additions ?? 0;
        deletions += change.deletions ?? 0;
    }

    return {
        additions,
        deletions,
        files: changedFiles.length,
    };
};

/**
 * Files this turn changed, as evidenced by its own edit/write calls.
 *
 * v1 also carried a working-tree snapshot on the user message, which supplied
 * line counts and was the only record of edits a turn delegated to subagents.
 * v2 has no such snapshot, so the turn's own tool calls are the whole story:
 * line counts come from each call's patch, and files a subagent changed in a
 * child session are not listed here.
 */
export const projectTurnChangedFiles = (
    assistantMessages: ChatMessageEntry[],
): TurnChangedFile[] | undefined => {
    const summary = summarizeLiveActivity(assistantMessages);

    // Every pill opens the turn diff: OpenCode 2 computes it from the turn's
    // snapshots (`GET /api/session/:id/diff`), which covers `write` results
    // and subagent edits that the tool calls alone cannot describe.
    const files = summary.changedFiles.map((change): TurnChangedFile => (
        change.additions !== undefined && change.deletions !== undefined
            ? { file: change.path, additions: change.additions, deletions: change.deletions, inTurnDiff: true }
            : { file: change.path, inTurnDiff: true }
    ));

    return files.length > 0 ? files : undefined;
};
