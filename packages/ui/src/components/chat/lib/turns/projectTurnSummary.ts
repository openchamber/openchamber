import type { SnapshotFileDiff } from '@opencode-ai/sdk/v2';
import { summarizeLiveActivity } from './liveActivitySummary';
import type { ChatMessageEntry, TurnChangedFile, TurnDiffStats, TurnSummaryRecord } from './types';

interface SummaryDiff {
    file?: string | null;
    additions?: number | null;
    deletions?: number | null;
}

interface UserSummaryPayload {
    body?: string | null;
    diffs?: SummaryDiff[] | null;
}

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

export const projectTurnDiffStats = (userMessage: ChatMessageEntry): TurnDiffStats | undefined => {
    const summary = (userMessage.info as { summary?: UserSummaryPayload | null }).summary;
    const diffs = summary?.diffs;
    if (!Array.isArray(diffs) || diffs.length === 0) {
        return undefined;
    }

    let additions = 0;
    let deletions = 0;
    let files = 0;

    diffs.forEach((diff) => {
        if (!diff) return;

        const diffAdditions = typeof diff.additions === 'number' ? diff.additions : 0;
        const diffDeletions = typeof diff.deletions === 'number' ? diff.deletions : 0;

        if (diffAdditions !== 0 || diffDeletions !== 0) {
            files += 1;
        }

        additions += diffAdditions;
        deletions += diffDeletions;
    });

    if (files === 0) {
        return undefined;
    }

    return {
        additions,
        deletions,
        files,
    };
};

/**
 * Files this turn changed, as evidenced by its own edit/write/patch calls.
 *
 * The user message's `summary.diffs` is a snapshot of the whole working tree
 * between turn start and end, so it also lists edits made by other sessions
 * or by hand in the same directory. It is therefore not used to decide which
 * files belong to the turn, only to supply line counts for a file the turn
 * touched: those match the turn diff view a file pill opens, and they fall
 * back to the tool call's own patch when the snapshot has no entry.
 *
 * One exception: edits a turn delegated to subagents live in child sessions
 * this projection cannot see, and the snapshot is their only record. When
 * the turn ran subagents, snapshot entries no own tool call touched are
 * appended after the turn's own files.
 */
export const projectTurnChangedFiles = (
    assistantMessages: ChatMessageEntry[],
    userMessage: ChatMessageEntry,
): TurnChangedFile[] | undefined => {
    const summary = summarizeLiveActivity(assistantMessages);
    const snapshotDiffs = userMessage.info.role === 'user' ? userMessage.info.summary?.diffs ?? [] : [];
    const snapshotByFile = new Map<string, SnapshotFileDiff>();
    for (const diff of snapshotDiffs) {
        if (diff.file) snapshotByFile.set(diff.file, diff);
    }

    const files = summary.changedFiles.map((change): TurnChangedFile => {
        const snapshot = snapshotByFile.get(change.path);
        if (!snapshot) {
            return change.additions !== undefined && change.deletions !== undefined
                ? { file: change.path, additions: change.additions, deletions: change.deletions, inTurnDiff: false }
                : { file: change.path, inTurnDiff: false };
        }
        // A snapshot without line changes (a binary write) has nothing to count.
        return snapshot.additions === 0 && snapshot.deletions === 0
            ? { file: change.path, inTurnDiff: true }
            : { file: change.path, additions: snapshot.additions, deletions: snapshot.deletions, inTurnDiff: true };
    });

    if (summary.subagents > 0) {
        const own = new Set(files.map((file) => file.file));
        for (const diff of snapshotDiffs) {
            if (!diff.file || own.has(diff.file) || (diff.additions === 0 && diff.deletions === 0)) continue;
            files.push({ file: diff.file, additions: diff.additions, deletions: diff.deletions, inTurnDiff: true });
        }
    }

    return files.length > 0 ? files : undefined;
};
