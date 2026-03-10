import { ACTIVITY_STANDALONE_TOOL_NAMES } from './constants';
import type {
    ChatMessageEntry,
    TurnActivityGroup,
    TurnActivityRecord,
    TurnPartRecord,
} from './types';

const isStandaloneTool = (toolName: unknown): boolean => {
    return typeof toolName === 'string' && ACTIVITY_STANDALONE_TOOL_NAMES.has(toolName.toLowerCase());
};

const getPartEndTime = (part: unknown): number | undefined => {
    const stateEnd = (part as { state?: { time?: { end?: unknown } } }).state?.time?.end;
    if (typeof stateEnd === 'number') {
        return stateEnd;
    }
    const timeEnd = (part as { time?: { end?: unknown } }).time?.end;
    return typeof timeEnd === 'number' ? timeEnd : undefined;
};

const getPartText = (part: unknown): string | undefined => {
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

const getMessageFinish = (message: ChatMessageEntry): string | undefined => {
    const finish = (message.info as { finish?: unknown }).finish;
    return typeof finish === 'string' ? finish : undefined;
};

const isAssistantMessageCompleted = (message: ChatMessageEntry): boolean => {
    const info = message.info as { time?: { completed?: unknown }; status?: unknown };
    const completed = info.time?.completed;
    const status = info.status;
    if (typeof completed !== 'number' || completed <= 0) {
        return false;
    }
    if (typeof status === 'string') {
        return status === 'completed';
    }
    return true;
};

const buildTurnPartRecord = (
    turnId: string,
    messageId: string,
    part: ChatMessageEntry['parts'][number],
    partIndex: number,
): TurnPartRecord => {
    return {
        id: part.id ?? `${messageId}-part-${partIndex}-${part.type}`,
        turnId,
        messageId,
        part,
        partIndex,
        endedAt: getPartEndTime(part),
    };
};

interface ProjectActivityInput {
    turnId: string;
    assistantMessages: ChatMessageEntry[];
    summarySourceMessageId?: string;
    showTextJustificationActivity: boolean;
}

interface ProjectActivityResult {
    activityParts: TurnActivityRecord[];
    activitySegments: TurnActivityGroup[];
    hasTools: boolean;
    hasReasoning: boolean;
}

export const projectTurnActivity = (input: ProjectActivityInput): ProjectActivityResult => {
    const activityParts: TurnActivityRecord[] = [];
    const hasTools = input.assistantMessages.some((message) =>
        message.parts.some((part) => part.type === 'tool')
    );
    const hasReasoning = input.assistantMessages.some((message) =>
        message.parts.some((part) => part.type === 'reasoning' && Boolean(getPartText(part)))
    );

    input.assistantMessages.forEach((message) => {
        message.parts.forEach((part, partIndex) => {
            if (part.type === 'tool') {
                activityParts.push({
                    ...buildTurnPartRecord(input.turnId, message.info.id, part, partIndex),
                    kind: 'tool',
                });
                return;
            }

            if (part.type === 'reasoning') {
                const text = getPartText(part);
                if (!text) {
                    return;
                }
                activityParts.push({
                    ...buildTurnPartRecord(input.turnId, message.info.id, part, partIndex),
                    kind: 'reasoning',
                });
                return;
            }

            if (!input.showTextJustificationActivity || part.type !== 'text') {
                return;
            }

            if (!isAssistantMessageCompleted(message)) {
                return;
            }

            const finish = getMessageFinish(message);
            if (!finish) {
                return;
            }

            if (finish === 'stop') {
                return;
            }

            const text = getPartText(part);
            if (!text) {
                return;
            }

            activityParts.push({
                ...buildTurnPartRecord(input.turnId, message.info.id, part, partIndex),
                kind: 'justification',
            });
        });
    });

    const activitySegments: TurnActivityGroup[] = [];
    const activityByPart = new WeakMap<object, TurnActivityRecord>();
    activityParts.forEach((activity) => {
        activityByPart.set(activity.part as object, activity);
    });

    const taskMessageById = new Map<string, string>();
    const taskOrder: string[] = [];
    const partsByAfterTool = new Map<string | null, TurnActivityRecord[]>();
    let currentAfterToolPartId: string | null = null;

    input.assistantMessages.forEach((message) => {
        const messageId = message.info.id;

        message.parts.forEach((part, partIndex) => {
            if (part.type === 'tool') {
                const toolName = (part as { tool?: unknown }).tool;
                if (isStandaloneTool(toolName)) {
                    const toolPartId = part.id ?? `${messageId}-part-${partIndex}-${part.type}`;
                    if (!taskMessageById.has(toolPartId)) {
                        taskMessageById.set(toolPartId, messageId);
                        taskOrder.push(toolPartId);
                    }
                    currentAfterToolPartId = toolPartId;
                    return;
                }
            }

            const activity = activityByPart.get(part as object);
            if (!activity) {
                return;
            }

            if (activity.kind === 'tool') {
                const toolName = (activity.part as { tool?: unknown }).tool;
                if (isStandaloneTool(toolName)) {
                    return;
                }
            }

            const list = partsByAfterTool.get(currentAfterToolPartId) ?? [];
            list.push(activity);
            partsByAfterTool.set(currentAfterToolPartId, list);
        });
    });

    const pickStartAnchor = (segmentParts: TurnActivityRecord[]): string | undefined => {
        if (segmentParts.length === 0) {
            return undefined;
        }

        const countByMessage = new Map<string, number>();
        segmentParts.forEach((activity) => {
            countByMessage.set(activity.messageId, (countByMessage.get(activity.messageId) ?? 0) + 1);
        });

        let firstWithAny: string | undefined;
        let cumulative = 0;
        for (const message of input.assistantMessages) {
            const count = countByMessage.get(message.info.id) ?? 0;
            if (count > 0 && !firstWithAny) {
                firstWithAny = message.info.id;
            }
            cumulative += count;
            if (cumulative >= 2) {
                return message.info.id;
            }
        }

        return firstWithAny;
    };

    const orderedKeys: Array<string | null> = [null, ...taskOrder];
    orderedKeys.forEach((afterToolPartId) => {
        const segmentParts = partsByAfterTool.get(afterToolPartId) ?? [];
        if (segmentParts.length === 0) {
            return;
        }

        const anchorMessageId = afterToolPartId === null
            ? pickStartAnchor(segmentParts)
            : taskMessageById.get(afterToolPartId);

        if (!anchorMessageId) {
            return;
        }

        activitySegments.push({
            id: `${input.turnId}:${anchorMessageId}:${afterToolPartId ?? 'start'}`,
            anchorMessageId,
            afterToolPartId,
            parts: segmentParts,
        });
    });

    return {
        activityParts,
        activitySegments,
        hasTools,
        hasReasoning,
    };
};
