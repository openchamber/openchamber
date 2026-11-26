import { readPromptOrigin } from '@/lib/opencode/prompt-origin';
import { readSessionNotice } from '@/lib/opencode/session-notices';
import { getLiveFinalMessage, getShownPages, hasUiBlock } from './liveActivity';
import type { TimelineEntry } from './timelineEntries';
import type { TurnRecord } from './types';

type TurnEntry = Extract<TimelineEntry, { kind: 'turn' }>;

export interface SupersededTurn {
    exchangeId: string;
    answeredAt: number | undefined;
    wake: boolean;
}

export interface ExchangePlan {
    superseded: ReadonlyMap<string, SupersededTurn>;
    sessionPrompts: ReadonlySet<string>;
    latestExchangeId: string | undefined;
    turnIds: readonly string[];
}

const isUserReply = (turn: TurnRecord): boolean => {
    const notice = readSessionNotice(turn.userMessage.info);
    return notice?.kind === 'lead-answer' || (notice?.kind === 'page-answer' && notice.outcome !== 'ui-not-drawn');
};

const keepsContentInView = (turn: TurnRecord): boolean => (
    getShownPages(turn.assistantMessages).length > 0
    || turn.assistantMessages.some((message) => message.parts.some((part) => part.type === 'text' && hasUiBlock(part.text)))
);

const failed = (turn: TurnRecord): boolean => {
    const info = turn.assistantMessages.at(-1)?.info;
    return info?.role === 'assistant' && info.error !== undefined;
};

const answeredAt = (turn: TurnRecord): number | undefined => {
    const info = turn.assistantMessages.at(-1)?.info;
    return info?.role === 'assistant' ? info.time.completed : undefined;
};

export const planExchanges = (entries: readonly TimelineEntry[], sessionPromptsAreOwn: boolean): ExchangePlan => {
    const superseded = new Map<string, SupersededTurn>();
    const sessionPrompts = new Set<string>();
    const turns = entries.filter((entry): entry is TurnEntry => entry.kind === 'turn').map((entry) => entry.turn);
    const openers = new Set<string>();
    let exchange: TurnRecord[] = [];
    let latestExchangeId: string | undefined;

    const close = () => {
        const first = exchange[0];
        if (!first) return;
        latestExchangeId = first.turnId;
        let lastAnswered = exchange.length - 1;
        while (lastAnswered >= 0 && !getLiveFinalMessage(exchange[lastAnswered].assistantMessages)) lastAnswered -= 1;
        exchange.forEach((turn, index) => {
            const replaced = index < lastAnswered || (index > lastAnswered && index < exchange.length - 1 && failed(turn));
            if (!replaced || turn.assistantMessages.length === 0 || keepsContentInView(turn)) return;
            superseded.set(turn.turnId, { exchangeId: first.turnId, answeredAt: answeredAt(turn), wake: !openers.has(turn.turnId) });
        });
    };

    turns.forEach((turn, index) => {
        const { info } = turn.userMessage;
        const fromSession = index > 0 && !sessionPromptsAreOwn && readPromptOrigin(info) !== undefined;
        if (fromSession) sessionPrompts.add(turn.turnId);
        const byUser = (info.role === 'user' && !fromSession) || info.role === 'compaction' || isUserReply(turn);
        if (byUser) openers.add(turn.turnId);
        if (byUser || index === 0) {
            close();
            exchange = [];
        }
        exchange.push(turn);
    });
    close();
    return { superseded, sessionPrompts, latestExchangeId, turnIds: turns.map((turn) => turn.turnId) };
};
