import { isHiddenUserMessage } from '../../message/hiddenUserMessage';
import { filterVisibleParts, isEmptyTextPart } from '../../message/partUtils';
import { answerChunkCuts } from './answerChunks';
import { getLiveFinalMessage, getShownPages, hasLiveActivity } from './liveActivity';
import type { TimelineEntry } from './timelineEntries';
import type { ChatMessageEntry } from './types';

type TurnEntry = Extract<TimelineEntry, { kind: 'turn' }>;
type UngroupedEntry = Extract<TimelineEntry, { kind: 'ungrouped' }>;

export type TextCut = { partId: string; offset: number };

export type MessageSlice = {
    from?: TextCut;
    to?: TextCut;
    index: number;
    count: number;
};

export type TimelineRow =
    | { kind: 'ungrouped'; key: string; entry: UngroupedEntry }
    | ({ kind: 'turn-head'; key: string } & TurnRowFields)
    | ({ kind: 'turn-fold'; key: string } & TurnRowFields)
    | ({ kind: 'turn-pages'; key: string } & TurnRowFields)
    | ({
        kind: 'turn-message';
        key: string;
        messageId: string;
        slice: MessageSlice | null;
        final: boolean;
    } & TurnRowFields);

type TurnRowFields = {
    entry: TurnEntry;
    underFold: boolean;
    keepText: boolean;
    finalMessageId: string | undefined;
    gapBelow: boolean;
};

export type TimelineRowsOptions = {
    collapsedActivity: boolean;
    keepActivityText: boolean;
    expandedTurns: ReadonlyMap<string, boolean>;
    showReasoningTraces: boolean;
};

const isMessageCompleted = (message: ChatMessageEntry): boolean => (
    message.info.role === 'assistant' && (message.info.time.completed ?? 0) > 0
);

const PARTS_PER_ROW = 24;

const messageCuts = (message: ChatMessageEntry, showReasoningTraces: boolean): TextCut[] => {
    const completed = isMessageCompleted(message);
    const cuts: TextCut[] = [];
    let partsInRow = 0;
    for (const part of filterVisibleParts(message.parts, { includeReasoning: showReasoningTraces })) {
        if (isEmptyTextPart(part)) continue;
        if (partsInRow === PARTS_PER_ROW) {
            cuts.push({ partId: part.id, offset: 0 });
            partsInRow = 0;
        }
        partsInRow += 1;
        if (!completed || part.type !== 'text' || part.time?.end === undefined) continue;
        const textCuts = answerChunkCuts(part.text);
        for (const offset of textCuts) cuts.push({ partId: part.id, offset });
        if (textCuts.length > 0) partsInRow = 1;
    }
    return cuts;
};

const sliceKey = (cut: TextCut) => `${cut.partId}:${cut.offset}`;

const turnRows = (entry: TurnEntry, options: TimelineRowsOptions): TimelineRow[] => {
    const { turn } = entry;
    const underFold = options.collapsedActivity && hasLiveActivity(turn, options.showReasoningTraces);
    const finalMessage = underFold ? getLiveFinalMessage(turn.assistantMessages) : undefined;
    const expanded = options.expandedTurns.get(turn.turnId) === true;
    const keepText = underFold && options.keepActivityText && !expanded;
    const fields = { entry, underFold, keepText, finalMessageId: finalMessage?.info.id, gapBelow: false };
    const rows: TimelineRow[] = [{ kind: 'turn-head', key: entry.key, ...fields }];
    const addMessage = (message: ChatMessageEntry, final = false) => {
        const messageId = message.info.id;
        const cuts = messageCuts(message, options.showReasoningTraces);
        if (cuts.length === 0) {
            rows.push({ kind: 'turn-message', key: `step:${messageId}`, ...fields, messageId, slice: null, final });
            return;
        }
        cuts.forEach((cut, index) => {
            const from = index === 0 ? undefined : cuts[index - 1];
            rows.push({
                kind: 'turn-message',
                key: from ? `step:${messageId}:${sliceKey(from)}` : `step:${messageId}`,
                ...fields,
                messageId,
                slice: from ? { from, to: cut, index, count: cuts.length + 1 } : { to: cut, index, count: cuts.length + 1 },
                final,
            });
        });
        const last = cuts[cuts.length - 1];
        rows.push({ kind: 'turn-message', key: `step:${messageId}:${sliceKey(last)}`, ...fields, messageId, slice: { from: last, index: cuts.length, count: cuts.length + 1 }, final });
    };

    if (underFold) {
        const activityMessages = finalMessage ? turn.assistantMessages.filter((message) => message !== finalMessage) : turn.assistantMessages;
        rows.push({ kind: 'turn-fold', key: `fold:${turn.turnId}`, ...fields });
        if (expanded) {
            const pages = finalMessage ? [] : getShownPages(turn.assistantMessages);
            const lastPageMessageId = pages[pages.length - 1]?.messageID;
            const split = lastPageMessageId ? activityMessages.findIndex((message) => message.info.id === lastPageMessageId) + 1 : 0;
            activityMessages.slice(0, split > 0 ? split : activityMessages.length).forEach((message) => addMessage(message));
            if (pages.length > 0) rows.push({ kind: 'turn-pages', key: `pages:${turn.turnId}`, ...fields });
            if (split > 0) activityMessages.slice(split).forEach((message) => addMessage(message));
        }
        if (finalMessage) addMessage(finalMessage, true);
    } else {
        turn.assistantMessages.forEach((message) => addMessage(message));
    }

    const last = rows[rows.length - 1];
    if (last.kind !== 'ungrouped' && !isHiddenUserMessage(entry.nextEntryFirstMessage)) rows[rows.length - 1] = { ...last, gapBelow: true };
    return rows;
};

const isSameSlice = (previous: MessageSlice | null, next: MessageSlice | null): boolean => (
    previous?.from?.partId === next?.from?.partId && previous?.from?.offset === next?.from?.offset
    && previous?.to?.partId === next?.to?.partId && previous?.to?.offset === next?.to?.offset
    && previous?.count === next?.count
);

const isSameRow = (previous: TimelineRow, next: TimelineRow): boolean => {
    if (previous.kind !== next.kind || previous.entry !== next.entry) return false;
    if (previous.kind === 'ungrouped' || next.kind === 'ungrouped') return true;
    if (previous.gapBelow !== next.gapBelow || previous.underFold !== next.underFold || previous.keepText !== next.keepText || previous.finalMessageId !== next.finalMessageId) return false;
    if (previous.kind === 'turn-message' && next.kind === 'turn-message') {
        return previous.messageId === next.messageId && previous.final === next.final && isSameSlice(previous.slice, next.slice);
    }
    return true;
};

export const buildTimelineRows = (
    entries: readonly TimelineEntry[],
    options: TimelineRowsOptions,
    previous: TimelineRow[],
): TimelineRow[] => {
    const previousByKey = new Map<string, TimelineRow>();
    for (const row of previous) previousByKey.set(row.key, row);
    const rows: TimelineRow[] = [];
    for (const entry of entries) {
        const built: TimelineRow[] = entry.kind === 'turn' ? turnRows(entry, options) : [{ kind: 'ungrouped', key: entry.key, entry }];
        for (const row of built) {
            const reusable = previousByKey.get(row.key);
            rows.push(reusable && isSameRow(reusable, row) ? reusable : row);
        }
    }
    const unchanged = rows.length === previous.length && rows.every((row, index) => row === previous[index]);
    return unchanged ? previous : rows;
};
