import { isHiddenUserMessage } from '../../message/hiddenUserMessage';
import { isActivityRowDrawn, segmentActivity, visibleMessageParts, type ActivitySegment } from './activityGroups';
import { answerChunkCuts } from './answerChunks';
import { getLiveFinalMessage, getShownPages, hasLiveActivity } from './liveActivity';
import type { TimelineEntry } from './timelineEntries';
import type { ExchangePlan } from './exchanges';
import type { ChatMessageEntry } from './types';
import type { Part } from '@/lib/opencode/model';

type TurnEntry = Extract<TimelineEntry, { kind: 'turn' }>;
type UngroupedEntry = Extract<TimelineEntry, { kind: 'ungrouped' }>;

export type TextCut = { partId: string; offset: number };

export type MessageSlice = {
    from?: TextCut;
    to?: TextCut;
    index: number;
    count: number;
};

type GroupRef = { key: string; messageIds: string[] };

export type TimelineRow =
    | { kind: 'ungrouped'; key: string; entry: UngroupedEntry }
    | ({ kind: 'turn-head'; key: string } & TurnRowFields)
    | ({ kind: 'turn-fold'; key: string } & TurnRowFields)
    | ({ kind: 'turn-pages'; key: string } & TurnRowFields)
    | ({ kind: 'turn-line'; key: string; open: boolean; unread: boolean; wake: boolean; groups: GroupRef[] } & TurnRowFields)
    | ({ kind: 'earlier-lines'; key: string; exchangeId: string; hiddenTurnIds: string[]; open: boolean; groups: GroupRef[] } & TurnRowFields)
    | ({ kind: 'turn-group'; key: string; parts: Part[]; messageIds: string[]; open: boolean } & TurnRowFields)
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
    finalMessageId: string | undefined;
    gapBelow: boolean;
    sessionPrompt: boolean;
    depth: number;
};

export type SupersededTurns = {
    plan: ExchangePlan;
    folded: ReadonlySet<string>;
    unreadSince: number | undefined;
};

export type TimelineRowsOptions = {
    collapsedActivity: boolean;
    groupedActivity?: boolean;
    working?: boolean;
    superseded?: SupersededTurns;
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
    for (const part of visibleMessageParts(message, showReasoningTraces)) {
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

const LIVE_GROUP_ROWS = 7;

const liveGroupPartIds = (segment: ActivitySegment, doneMessageIds: ReadonlySet<string>): ReadonlySet<string> => (
    new Set(segment.parts.filter((part) => isActivityRowDrawn(part, doneMessageIds.has(part.messageID))).slice(-LIVE_GROUP_ROWS).map((part) => part.id))
);

export const AFTER_LAST_PART: TextCut = { partId: 'after-last-part', offset: 0 };

type Piece = { from?: TextCut; to?: TextCut; segment: ActivitySegment | undefined; partIds: string[] };

const messagePieces = (message: ChatMessageEntry, segmentByPart: ReadonlyMap<string, ActivitySegment>, showReasoningTraces: boolean): Piece[] => {
    const parts = visibleMessageParts(message, showReasoningTraces);
    const innerCuts = messageCuts(message, showReasoningTraces);
    const pieces: Piece[] = [];
    parts.forEach((part, index) => {
        const segment = segmentByPart.get(part.id);
        const previous = pieces.at(-1);
        const cutHere = innerCuts.some((cut) => cut.partId === part.id && cut.offset === 0);
        const sameLine = previous !== undefined && (previous.segment === segment || (!previous.segment?.phase && !segment?.phase));
        if (!sameLine || cutHere) {
            const from = index === 0 ? undefined : { partId: part.id, offset: 0 };
            if (previous) previous.to = from;
            pieces.push({ from, segment, partIds: [] });
        }
        pieces.at(-1)?.partIds.push(part.id);
        for (const cut of innerCuts) {
            if (cut.partId !== part.id || cut.offset === 0) continue;
            const open = pieces.at(-1);
            if (open) open.to = cut;
            pieces.push({ from: cut, segment, partIds: [part.id] });
        }
    });
    return pieces.length > 0 ? pieces : [{ segment: undefined, partIds: [] }];
};

const groupedRows = (entry: TurnEntry, options: TimelineRowsOptions, fields: TurnRowFields): TimelineRow[] => {
    const { assistantMessages } = entry.turn;
    const live = entry.isLastTurn && options.working === true && !getLiveFinalMessage(assistantMessages);
    const segments = segmentActivity(assistantMessages, options.showReasoningTraces, live);
    const segmentByPart = new Map(segments.flatMap((segment) => segment.parts.map((part) => [part.id, segment] as const)));
    const lastSegment = segments.at(-1);
    const livePartIds = live && lastSegment ? liveGroupPartIds(lastSegment, new Set(assistantMessages.filter(isMessageCompleted).map((message) => message.info.id))) : new Set<string>();
    const started = new Set<string>();
    const rows: TimelineRow[] = [];
    assistantMessages.forEach((message, messageIndex) => {
        const messageId = message.info.id;
        const isLast = messageIndex === assistantMessages.length - 1;
        const pieces = messagePieces(message, segmentByPart, options.showReasoningTraces);
        const emitted: Array<{ row: Extract<TimelineRow, { kind: 'turn-message' }>; piece: Pick<Piece, 'from' | 'to'>; keyFrom?: TextCut }> = [];
        pieces.forEach((piece, index) => {
            const { segment } = piece;
            const open = segment?.grouped ? options.expandedTurns.get(segment.key) === true : true;
            if (segment?.grouped && !started.has(segment.key)) {
                started.add(segment.key);
                rows.push({ kind: 'turn-group', ...fields, key: segment.key, parts: segment.parts, messageIds: segment.messageIds, open });
            }
            const running = live && segment !== undefined && segment === lastSegment && piece.partIds.some((id) => livePartIds.has(id));
            const firstLive = running && !open ? piece.partIds.findIndex((id) => livePartIds.has(id)) : 0;
            const endsTurn = isLast && index === pieces.length - 1 && (live || message.info.role !== 'assistant' || message.info.error !== undefined || message.info.finish === 'stop');
            if (!open && !running && !endsTurn) return;
            const row: Extract<TimelineRow, { kind: 'turn-message' }> = {
                kind: 'turn-message',
                ...fields,
                depth: segment?.grouped && (open || running) ? 1 : 0,
                key: `step:${messageId}`,
                messageId,
                slice: null,
                final: false,
            };
            const shownFrom = firstLive > 0 ? { partId: piece.partIds[firstLive], offset: 0 } : piece.from;
            emitted.push(open || running ? { row, piece: { from: shownFrom, to: piece.to }, keyFrom: piece.from } : { row, piece: { from: AFTER_LAST_PART }, keyFrom: AFTER_LAST_PART });
            rows.push(row);
        });
        emitted.forEach(({ row, piece: { from, to }, keyFrom }, index) => {
            if (!from && !to) return;
            row.key = keyFrom ? `step:${messageId}:${sliceKey(keyFrom)}` : row.key;
            row.slice = { from, to, index, count: emitted.length };
        });
    });
    return rows;
};

const turnRows = (entry: TurnEntry, options: TimelineRowsOptions): TimelineRow[] => {
    const { turn } = entry;
    const underFold = options.collapsedActivity && hasLiveActivity(turn, options.showReasoningTraces);
    const finalMessage = underFold ? getLiveFinalMessage(turn.assistantMessages) : undefined;
    const expanded = options.expandedTurns.get(turn.turnId) === true;
    const sessionPrompt = options.superseded?.plan.sessionPrompts.has(turn.turnId) === true;
    const fields = { entry, underFold, sessionPrompt, finalMessageId: finalMessage?.info.id, gapBelow: false, depth: 0 };
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

    if (options.groupedActivity) {
        rows.push(...groupedRows(entry, options, fields));
    } else if (underFold) {
        const activityMessages = finalMessage ? turn.assistantMessages.filter((message) => message !== finalMessage) : turn.assistantMessages;
        rows.push({ kind: 'turn-fold', key: `fold:${turn.turnId}`, ...fields });
        if (expanded) {
            const pages = finalMessage ? [] : getShownPages(turn.assistantMessages);
            const lastPageMessageId = pages[pages.length - 1]?.messageID;
            const split = lastPageMessageId ? activityMessages.findIndex((message) => message.info.id === lastPageMessageId) + 1 : 0;
            const start = rows.length;
            activityMessages.slice(0, split > 0 ? split : activityMessages.length).forEach((message) => addMessage(message));
            if (pages.length > 0) rows.push({ kind: 'turn-pages', key: `pages:${turn.turnId}`, ...fields });
            if (split > 0) activityMessages.slice(split).forEach((message) => addMessage(message));
            for (const row of rows.slice(start)) if (row.kind !== 'ungrouped') row.depth = 1;
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

const sameItems = <T,>(previous: readonly T[], next: readonly T[]): boolean => (
    previous.length === next.length && previous.every((item, index) => item === next[index])
);

const isSameRow = (previous: TimelineRow, next: TimelineRow): boolean => {
    if (previous.kind !== next.kind || previous.entry !== next.entry) return false;
    if (previous.kind === 'ungrouped' || next.kind === 'ungrouped') return true;
    if (previous.depth !== next.depth || previous.gapBelow !== next.gapBelow || previous.underFold !== next.underFold || previous.sessionPrompt !== next.sessionPrompt || previous.finalMessageId !== next.finalMessageId) return false;
    if (previous.kind === 'turn-message' && next.kind === 'turn-message') {
        return previous.messageId === next.messageId && previous.final === next.final && isSameSlice(previous.slice, next.slice);
    }
    if (previous.kind === 'turn-line' && next.kind === 'turn-line') {
        return previous.open === next.open && previous.unread === next.unread && previous.wake === next.wake;
    }
    if (previous.kind === 'earlier-lines' && next.kind === 'earlier-lines') {
        return previous.open === next.open && sameItems(previous.hiddenTurnIds, next.hiddenTurnIds);
    }
    if (previous.kind === 'turn-group' && next.kind === 'turn-group') {
        return previous.open === next.open && sameItems(previous.parts, next.parts);
    }
    return true;
};

const VISIBLE_LINES = 7;

export const lineKey = (turnId: string): string => `line:${turnId}`;
const earlierLinesKey = (exchangeId: string): string => `earlier:${exchangeId}`;

const hiddenLines = ({ plan, folded }: SupersededTurns): Map<string, string[]> => {
    const lines = new Map<string, string[]>();
    for (const [turnId, { exchangeId }] of plan.superseded) {
        if (folded.has(turnId)) lines.set(exchangeId, [...(lines.get(exchangeId) ?? []), turnId]);
    }
    const hidden = new Map<string, string[]>();
    for (const [exchangeId, turnIds] of lines) {
        if (turnIds.length > VISIBLE_LINES + 1) hidden.set(exchangeId, turnIds.slice(0, turnIds.length - VISIBLE_LINES));
    }
    return hidden;
};

const lineRows = (entry: TurnEntry, rows: TimelineRow[], options: TimelineRowsOptions, superseded: SupersededTurns, hidden: ReadonlyMap<string, string[]>, hiddenGroups: Map<string, GroupRef[]>): TimelineRow[] => {
    const { turnId } = entry.turn;
    const line = superseded.plan.superseded.get(turnId);
    const head = rows[0];
    if (!line || !head || head.kind === 'ungrouped') return rows;
    const { underFold, finalMessageId, sessionPrompt } = head;
    const fields: TurnRowFields = { entry, underFold, finalMessageId, sessionPrompt, gapBelow: false, depth: 0 };
    const { wake } = line;
    const groups = rows.flatMap((row) => (row.kind === 'turn-group' && !row.open ? [{ key: row.key, messageIds: row.messageIds }] : []));
    const hiddenTurnIds = hidden.get(line.exchangeId);
    const earlierGroups = hiddenGroups.get(line.exchangeId) ?? [];
    hiddenGroups.set(line.exchangeId, earlierGroups);
    const earlierOpen = options.expandedTurns.get(earlierLinesKey(line.exchangeId)) === true;
    const built: TimelineRow[] = wake ? [] : [head];
    if (hiddenTurnIds?.[0] === turnId) {
        built.push({ kind: 'earlier-lines', ...fields, key: earlierLinesKey(line.exchangeId), exchangeId: line.exchangeId, hiddenTurnIds, open: earlierOpen, groups: earlierGroups });
    }
    if (hiddenTurnIds?.includes(turnId) && !earlierOpen) {
        earlierGroups.push(...groups);
        return built;
    }
    const open = options.expandedTurns.get(lineKey(turnId)) === true;
    const unread = superseded.unreadSince !== undefined && (line.answeredAt ?? 0) > superseded.unreadSince;
    built.push({ kind: 'turn-line', ...fields, key: lineKey(turnId), open, unread, wake, groups });
    if (open) {
        for (const row of wake ? rows : rows.slice(1)) built.push(row.kind === 'ungrouped' ? row : { ...row, depth: row.depth + 1 });
    }
    return built;
};

export const buildTimelineRows = (
    entries: readonly TimelineEntry[],
    options: TimelineRowsOptions,
    previous: TimelineRow[],
): TimelineRow[] => {
    const previousByKey = new Map<string, TimelineRow>();
    for (const row of previous) previousByKey.set(row.key, row);
    const rows: TimelineRow[] = [];
    const { superseded } = options;
    const hidden = superseded ? hiddenLines(superseded) : new Map<string, string[]>();
    const hiddenGroups = new Map<string, GroupRef[]>();
    for (const entry of entries) {
        let built: TimelineRow[] = entry.kind === 'turn' ? turnRows(entry, options) : [{ kind: 'ungrouped', key: entry.key, entry }];
        if (superseded && entry.kind === 'turn' && superseded.folded.has(entry.turn.turnId)) built = lineRows(entry, built, options, superseded, hidden, hiddenGroups);
        for (const row of built) {
            const reusable = previousByKey.get(row.key);
            rows.push(reusable && isSameRow(reusable, row) ? reusable : row);
        }
    }
    const unchanged = rows.length === previous.length && rows.every((row, index) => row === previous[index]);
    return unchanged ? previous : rows;
};
