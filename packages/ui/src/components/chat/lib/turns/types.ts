import type { Message, Part } from '@/lib/opencode/model';

export interface ChatMessageEntry {
    info: Message;
    parts: Part[];
}

type TurnActivityKind = 'tool' | 'reasoning';

export interface TurnMessageRecord {
    messageId: string;
    role: string;
    message: ChatMessageEntry;
    order: number;
}

export interface TurnPartRecord {
    id: string;
    turnId: string;
    messageId: string;
    part: Part;
    partIndex: number;
    endedAt?: number;
}

export interface TurnActivityRecord extends TurnPartRecord {
    kind: TurnActivityKind;
}

export interface TurnChangedFile {
    file: string;
    /** Absent when neither the turn diff nor the tool call reports line counts. */
    additions?: number;
    deletions?: number;
    /** False when the turn diff view has no entry for this path, so a pill cannot open it. */
    inTurnDiff?: boolean;
}

export interface TurnSummaryRecord {
    text?: string;
    sourceMessageId?: string;
    sourcePartId?: string;
}

export interface TurnStreamState {
    isStreaming: boolean;
    isRetrying: boolean;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
}

export interface TurnRecord {
    turnId: string;
    userMessageId: string;
    userMessage: ChatMessageEntry;
    headerMessageId?: string;
    messages: TurnMessageRecord[];
    assistantMessageIds: string[];
    assistantMessages: ChatMessageEntry[];
    /**
     * Session notices that came after the prompt before the run's first step
     * existed. They render in the turn until that step arrives and takes them
     * as rows (`attachSyntheticContext`).
     */
    waitingNotices?: ChatMessageEntry[];
    activityParts: TurnActivityRecord[];
    summary: TurnSummaryRecord;
    summaryText?: string;
    hasTools: boolean;
    hasReasoning: boolean;
    changedFiles?: TurnChangedFile[];
    stream: TurnStreamState;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
}

interface TurnMessageMeta {
    turnId: string;
    messageId: string;
    userMessageId: string;
    isUserMessage: boolean;
    isAssistantMessage: boolean;
    isFirstAssistantInTurn: boolean;
    isLastAssistantInTurn: boolean;
    headerMessageId?: string;
}

export interface TurnIndexes {
    turnById: Map<string, TurnRecord>;
    messageToTurnId: Map<string, string>;
    messageMetaById: Map<string, TurnMessageMeta>;
}

export interface TurnProjectionResult {
    turns: TurnRecord[];
    indexes: TurnIndexes;
    lastTurnId: string | null;
    lastTurnMessageIds: Set<string>;
    ungroupedMessageIds: Set<string>;
}

export type Turn = Pick<TurnRecord, 'turnId' | 'userMessage' | 'assistantMessages' | 'waitingNotices'>;

export interface TurnGroupingContext {
    turnId: string;
    isFirstAssistantInTurn: boolean;
    isLastAssistantInTurn: boolean;
    /**
     * Text the turn's earlier assistant messages wrote, one entry per text
     * part, in order. Set on the last assistant message only, so the turn
     * footer can copy and save the whole reply.
     */
    earlierAssistantText?: string[];
    isLatestTurn: boolean;
    summaryBody?: string;
    activityParts?: TurnActivityRecord[];
    headerMessageId?: string;
    hasTools: boolean;
    hasReasoning: boolean;
    changedFiles?: TurnChangedFile[];
    userMessageCreatedAt?: number;
    /** Model variant ("thinking" etc.) the turn ran with, read off its assistant messages. */
    assistantVariant?: string;
    isWorking: boolean;
}
