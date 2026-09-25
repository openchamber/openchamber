import { isHiddenUserMessage } from '../../message/hiddenUserMessage';
import { projectTurnActivity } from './projectTurnActivity';
import { projectTurnIndexes } from './projectTurnIndexes';
import { projectTurnChangedFiles, projectTurnDiffStats, projectTurnSummary } from './projectTurnSummary';
import type {
    ChatMessageEntry,
    TurnMessageRecord,
    TurnProjectionResult,
    TurnRecord,
    TurnStreamState,
} from './types';

const resolveMessageRole = (message: ChatMessageEntry): string => {
    const role = (message.info as { clientRole?: string | null; role?: string | null }).clientRole ?? message.info.role;
    return typeof role === 'string' ? role : '';
};

const getMessageCreatedAt = (message: ChatMessageEntry): number | undefined => {
    const created = (message.info as { time?: { created?: unknown } }).time?.created;
    return typeof created === 'number' ? created : undefined;
};

const getMessageCompletedAt = (message: ChatMessageEntry): number | undefined => {
    const completed = (message.info as { time?: { completed?: unknown } }).time?.completed;
    return typeof completed === 'number' ? completed : undefined;
};

const getUserSummaryBody = (message: ChatMessageEntry): string | undefined => {
    const summaryBody = (message.info as { summary?: { body?: unknown } | null | undefined })?.summary?.body;
    if (typeof summaryBody !== 'string') {
        return undefined;
    }

    const trimmed = summaryBody.trim();
    return trimmed.length > 0 ? summaryBody : undefined;
};

const createTurnMessageRecord = (message: ChatMessageEntry, order: number): TurnMessageRecord => {
    const role = resolveMessageRole(message);
    return {
        messageId: message.info.id,
        role,
        message,
        order,
    };
};

const buildTurnStreamState = (userMessage: ChatMessageEntry, assistantMessages: ChatMessageEntry[]): TurnStreamState => {
    const startedAt = getMessageCreatedAt(userMessage);
    let completedAt: number | undefined;
    let isStreaming = false;

    assistantMessages.forEach((message) => {
        const completed = getMessageCompletedAt(message);
        if (typeof completed === 'number') {
            completedAt = Math.max(completedAt ?? 0, completed);
        } else {
            isStreaming = true;
        }
    });

    const durationMs = typeof startedAt === 'number' && typeof completedAt === 'number' && completedAt >= startedAt
        ? completedAt - startedAt
        : undefined;

    return {
        isStreaming,
        isRetrying: assistantMessages.length > 1,
        startedAt,
        completedAt,
        durationMs,
    };
};

interface ProjectTurnRecordsOptions {
    previousProjection?: TurnProjectionResult | null;
    showTextJustificationActivity: boolean;
    showTurnChangedFiles: boolean;
    /**
     * When true, a turn whose user message is hidden (no visible display parts,
     * e.g. a prompt OpenChamber sent on the user's behalf) is merged into the
     * previous turn instead of starting a new one.
     */
    mergeHiddenUserTurns?: boolean;
}

const DEFAULT_OPTIONS: ProjectTurnRecordsOptions = {
    previousProjection: null,
    showTextJustificationActivity: false,
    showTurnChangedFiles: false,
    mergeHiddenUserTurns: false,
};

const areSameMessageRefs = (left: ChatMessageEntry[], right: ChatMessageEntry[]): boolean => {
    if (left === right) {
        return true;
    }
    if (left.length !== right.length) {
        return false;
    }

    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }

    return true;
};

const canReusePreviousTurn = (previous: TurnRecord, next: TurnRecord): boolean => {
    return previous.userMessage === next.userMessage
        && previous.headerMessageId === next.headerMessageId
        && areSameMessageRefs(previous.assistantMessages, next.assistantMessages);
};

const hydrateTurnRecord = (
    turn: TurnRecord,
    effectiveOptions: ProjectTurnRecordsOptions,
): TurnRecord => {
    turn.summary = projectTurnSummary(turn.assistantMessages);
    turn.summaryText = turn.summary.text ?? getUserSummaryBody(turn.userMessage);
    // Changed files and their line counts are only shown under a finished
    // answer, so tool patches are not parsed while the turn still streams.
    const finalMessage = turn.assistantMessages[turn.assistantMessages.length - 1];
    const hasFinalAnswer = finalMessage?.info.role === 'assistant' && finalMessage.info.finish === 'stop';
    const changedFiles = hasFinalAnswer ? projectTurnChangedFiles(turn.assistantMessages) : undefined;
    turn.diffStats = projectTurnDiffStats(changedFiles);
    turn.changedFiles = effectiveOptions.showTurnChangedFiles ? changedFiles : undefined;

    const activity = projectTurnActivity({
        turnId: turn.turnId,
        assistantMessages: turn.assistantMessages,
        summarySourceMessageId: turn.summary.sourceMessageId,
        summarySourcePartId: turn.summary.sourcePartId,
        showTextJustificationActivity: effectiveOptions.showTextJustificationActivity,
    });
    turn.activityParts = activity.activityParts;
    turn.activitySegments = activity.activitySegments;
    turn.hasTools = activity.hasTools;
    turn.hasReasoning = activity.hasReasoning;

    turn.stream = buildTurnStreamState(turn.userMessage, turn.assistantMessages);
    turn.startedAt = turn.stream.startedAt;
    turn.completedAt = turn.stream.completedAt;
    turn.durationMs = turn.stream.durationMs;
    return turn;
};

const hydrateStableTurnRecords = (
    turns: TurnRecord[],
    effectiveOptions: ProjectTurnRecordsOptions,
): TurnRecord[] => {
    const previousProjection = effectiveOptions.previousProjection;
    if (!previousProjection || previousProjection.turns.length === 0 || turns.length === 0) {
        return turns.map((turn) => hydrateTurnRecord(turn, effectiveOptions));
    }

    let canReuseTurnArray = previousProjection.turns.length === turns.length;
    let reusedAnyTurn = false;

    const nextTurns = turns.map((turn, index) => {
        const previousTurn = previousProjection.indexes.turnById.get(turn.turnId);
        if (previousTurn && canReusePreviousTurn(previousTurn, turn)) {
            reusedAnyTurn = true;
            if (previousProjection.turns[index] !== previousTurn) {
                canReuseTurnArray = false;
            }
            return previousTurn;
        }

        canReuseTurnArray = false;
        return hydrateTurnRecord(turn, effectiveOptions);
    });

    if (canReuseTurnArray && reusedAnyTurn) {
        return previousProjection.turns;
    }

    return nextTurns;
};

export const projectTurnRecords = (
    messages: ChatMessageEntry[],
    options?: Partial<ProjectTurnRecordsOptions>,
): TurnProjectionResult => {
    const effectiveOptions: ProjectTurnRecordsOptions = {
        ...DEFAULT_OPTIONS,
        ...options,
    };

    const turns: TurnRecord[] = [];
    const groupedMessageIds = new Set<string>();

    const mergeHiddenUserTurns = effectiveOptions.mergeHiddenUserTurns;

    // v2 assistant messages carry no parent id: a reply belongs to the last
    // user message before it, so one ordered pass does the grouping. An
    // assistant message with no user message ahead of it stays ungrouped.
    let currentTurn: TurnRecord | undefined;

    messages.forEach((message, index) => {
        const role = resolveMessageRole(message);
        if (role === 'assistant') {
            if (!currentTurn) return;
            currentTurn.assistantMessages.push(message);
            currentTurn.assistantMessageIds.push(message.info.id);
            currentTurn.messages.push(createTurnMessageRecord(message, index));
            if (!currentTurn.headerMessageId) {
                currentTurn.headerMessageId = message.info.id;
            }
            groupedMessageIds.add(message.info.id);
            return;
        }
        if (role !== 'user') {
            return;
        }

        const previousTurn = turns[turns.length - 1];
        if (
            mergeHiddenUserTurns
            && previousTurn
            && isHiddenUserMessage(message)
        ) {
            currentTurn = previousTurn;
            previousTurn.messages.push(createTurnMessageRecord(message, index));
            groupedMessageIds.add(message.info.id);
            return;
        }

        const turnId = message.info.id;
        const turn: TurnRecord = {
            turnId,
            userMessageId: message.info.id,
            userMessage: message,
            headerMessageId: undefined,
            messages: [createTurnMessageRecord(message, index)],
            assistantMessageIds: [],
            assistantMessages: [],
            activityParts: [],
            activitySegments: [],
            summary: {},
            summaryText: undefined,
            hasTools: false,
            hasReasoning: false,
            diffStats: undefined,
            changedFiles: undefined,
            stream: {
                isStreaming: false,
                isRetrying: false,
            },
        };
        turns.push(turn);
        currentTurn = turn;
        groupedMessageIds.add(message.info.id);
    });

    const stableTurns = hydrateStableTurnRecords(turns, effectiveOptions);
    const projection = projectTurnIndexes(stableTurns);
    const ungroupedMessageIds = new Set<string>();
    messages.forEach((message) => {
        if (resolveMessageRole(message) === 'assistant') {
            return;
        }
        if (!groupedMessageIds.has(message.info.id)) {
            ungroupedMessageIds.add(message.info.id);
        }
    });

    return {
        ...projection,
        ungroupedMessageIds,
    };
};
