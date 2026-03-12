import { projectTurnActivity } from './projectTurnActivity';
import { projectTurnIndexes } from './projectTurnIndexes';
import { projectTurnDiffStats, projectTurnSummary } from './projectTurnSummary';
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

const getMessageParentId = (message: ChatMessageEntry): string | undefined => {
    const parentId = (message.info as { parentID?: unknown }).parentID;
    if (typeof parentId !== 'string' || parentId.trim().length === 0) {
        return undefined;
    }
    return parentId;
};

const getMessageCreatedAt = (message: ChatMessageEntry): number | undefined => {
    const created = (message.info as { time?: { created?: unknown } }).time?.created;
    return typeof created === 'number' ? created : undefined;
};

const getMessageCompletedAt = (message: ChatMessageEntry): number | undefined => {
    const completed = (message.info as { time?: { completed?: unknown } }).time?.completed;
    return typeof completed === 'number' ? completed : undefined;
};

const getMessageFinish = (message: ChatMessageEntry): string | undefined => {
    const finish = (message.info as { finish?: unknown }).finish;
    return typeof finish === 'string' ? finish : undefined;
};

const getMessageStatus = (message: ChatMessageEntry): string | undefined => {
    const status = (message.info as { status?: unknown }).status;
    return typeof status === 'string' ? status : undefined;
};

const getPartText = (part: ChatMessageEntry['parts'][number]): string | undefined => {
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string') {
        return text;
    }
    const content = (part as { content?: unknown }).content;
    return typeof content === 'string' ? content : undefined;
};

const arePartsEquivalentForReuse = (
    previousPart: ChatMessageEntry['parts'][number],
    nextPart: ChatMessageEntry['parts'][number],
): boolean => {
    if (previousPart === nextPart) {
        return true;
    }

    if (previousPart.type !== nextPart.type) {
        return false;
    }

    if (previousPart.id && nextPart.id && previousPart.id !== nextPart.id) {
        return false;
    }

    if (previousPart.type === 'text' || previousPart.type === 'reasoning') {
        return getPartText(previousPart) === getPartText(nextPart);
    }

    if (previousPart.type === 'tool') {
        const previousTool = previousPart as {
            tool?: unknown;
            callID?: unknown;
            state?: { status?: unknown };
        };
        const nextTool = nextPart as {
            tool?: unknown;
            callID?: unknown;
            state?: { status?: unknown };
        };

        return previousTool.tool === nextTool.tool
            && previousTool.callID === nextTool.callID
            && previousTool.state?.status === nextTool.state?.status;
    }

    return true;
};

const areMessagesEquivalentForReuse = (previousMessage: ChatMessageEntry, nextMessage: ChatMessageEntry): boolean => {
    if (previousMessage === nextMessage) {
        return true;
    }

    if (previousMessage.info.id !== nextMessage.info.id) {
        return false;
    }

    if (getMessageCompletedAt(previousMessage) !== getMessageCompletedAt(nextMessage)) {
        return false;
    }

    if (getMessageFinish(previousMessage) !== getMessageFinish(nextMessage)) {
        return false;
    }

    if (getMessageStatus(previousMessage) !== getMessageStatus(nextMessage)) {
        return false;
    }

    if (previousMessage.parts.length !== nextMessage.parts.length) {
        return false;
    }

    for (let index = 0; index < previousMessage.parts.length; index += 1) {
        if (!arePartsEquivalentForReuse(previousMessage.parts[index], nextMessage.parts[index])) {
            return false;
        }
    }

    return true;
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
        parentMessageId: getMessageParentId(message),
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
}

const DEFAULT_OPTIONS: ProjectTurnRecordsOptions = {
    previousProjection: null,
    showTextJustificationActivity: false,
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
    const turnByUserId = new Map<string, TurnRecord>();
    const previousTurnsById = new Map((effectiveOptions.previousProjection?.turns ?? []).map((turn) => [turn.turnId, turn]));
    const groupedMessageIds = new Set<string>();
    let currentTurn: TurnRecord | undefined;

    messages.forEach((message, index) => {
        const role = resolveMessageRole(message);
        if (role === 'user') {
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
                stream: {
                    isStreaming: false,
                    isRetrying: false,
                },
            };
            turns.push(turn);
            turnByUserId.set(turn.userMessageId, turn);
            groupedMessageIds.add(message.info.id);
            currentTurn = turn;
            return;
        }

        if (role !== 'assistant') {
            return;
        }

        const parentId = getMessageParentId(message);
        const parentTurn = parentId ? turnByUserId.get(parentId) : undefined;
        const targetTurn = parentTurn ?? currentTurn;
        if (!targetTurn) {
            return;
        }

        targetTurn.assistantMessages.push(message);
        targetTurn.assistantMessageIds.push(message.info.id);
        targetTurn.messages.push(createTurnMessageRecord(message, index));
        if (!targetTurn.headerMessageId) {
            targetTurn.headerMessageId = message.info.id;
        }
        groupedMessageIds.add(message.info.id);

        if (!parentTurn) {
            currentTurn = targetTurn;
        }
    });

    turns.forEach((turn) => {
        const previousTurn = previousTurnsById.get(turn.turnId);
        const canReuseComputed = (() => {
            if (!previousTurn) {
                return false;
            }
            if (previousTurn.stream.isStreaming) {
                return false;
            }
            if (!areMessagesEquivalentForReuse(previousTurn.userMessage, turn.userMessage)) {
                return false;
            }
            if (previousTurn.assistantMessages.length !== turn.assistantMessages.length) {
                return false;
            }
            for (let index = 0; index < turn.assistantMessages.length; index += 1) {
                if (!areMessagesEquivalentForReuse(previousTurn.assistantMessages[index], turn.assistantMessages[index])) {
                    return false;
                }
            }
            return true;
        })();

        if (canReuseComputed && previousTurn) {
            turn.summary = previousTurn.summary;
            turn.summaryText = previousTurn.summaryText;
            turn.diffStats = previousTurn.diffStats;
            turn.activityParts = previousTurn.activityParts;
            turn.activitySegments = previousTurn.activitySegments;
            turn.hasTools = previousTurn.hasTools;
            turn.hasReasoning = previousTurn.hasReasoning;
            turn.stream = previousTurn.stream;
            turn.startedAt = previousTurn.startedAt;
            turn.completedAt = previousTurn.completedAt;
            turn.durationMs = previousTurn.durationMs;
            return;
        }

        turn.summary = projectTurnSummary(turn.assistantMessages);
        turn.summaryText = turn.summary.text ?? getUserSummaryBody(turn.userMessage);
        turn.diffStats = projectTurnDiffStats(turn.userMessage);

        const activity = projectTurnActivity({
            turnId: turn.turnId,
            assistantMessages: turn.assistantMessages,
            summarySourceMessageId: turn.summary.sourceMessageId,
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
    });

    const projection = projectTurnIndexes(turns);
    const ungroupedMessageIds = new Set<string>();
    messages.forEach((message) => {
        if (!groupedMessageIds.has(message.info.id)) {
            ungroupedMessageIds.add(message.info.id);
        }
    });

    return {
        ...projection,
        ungroupedMessageIds,
    };
};
