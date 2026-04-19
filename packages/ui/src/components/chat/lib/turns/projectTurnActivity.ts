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
    summarySourcePartId?: string;
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
    let hasTools = false;
    let hasReasoning = false;

    input.assistantMessages.forEach((message) => {
        message.parts.forEach((part) => {
            if (part.type === 'tool') {
                hasTools = true;
                return;
            }

            if (part.type === 'reasoning' && getPartText(part)) {
                hasReasoning = true;
            }
        });
    });

    const taskMessageById = new Map<string, string>();
    const taskOrder: string[] = [];
    const partsByAfterTool = new Map<string | null, TurnActivityRecord[]>();
    let currentAfterToolPartId: string | null = null;

    input.assistantMessages.forEach((message) => {
        const finish = getMessageFinish(message);
        const messageHasTool = message.parts.some((part) => part.type === 'tool');

        message.parts.forEach((part, partIndex) => {
            const isTool = part.type === 'tool';

            const text = part.type === 'reasoning' || part.type === 'text'
                ? getPartText(part)
                : undefined;
            const partId = part.id ?? `${message.info.id}-part-${partIndex}-${part.type}`;

            const toolName = isTool
                ? (part as { tool?: unknown }).tool
                : undefined;
            const standaloneTool = isTool && isStandaloneTool(toolName);
            if (standaloneTool) {
                const toolPartId = partId;
                if (!taskMessageById.has(toolPartId)) {
                    taskMessageById.set(toolPartId, message.info.id);
                    taskOrder.push(toolPartId);
                }
                currentAfterToolPartId = toolPartId;
            }

            const isConfirmedSummaryText = part.type === 'text'
                && typeof text === 'string'
                && finish === 'stop'
                && input.summarySourceMessageId === message.info.id
                && input.summarySourcePartId === partId;

            let kind: TurnActivityRecord['kind'] | null = null;
            if (isTool) {
                kind = 'tool';
            } else if (part.type === 'reasoning') {
                if (text) {
                    kind = 'reasoning';
                }
            } else if (
                input.showTextJustificationActivity
                && part.type === 'text'
                && text
                && !isConfirmedSummaryText
                && (messageHasTool || (typeof finish === 'string' && finish !== 'stop'))
            ) {
                kind = 'justification';
            }

            if (!kind) {
                return;
            }

            const activity: TurnActivityRecord = {
                ...buildTurnPartRecord(input.turnId, message.info.id, part, partIndex),
                kind,
            };
            activityParts.push(activity);

            if (kind === 'tool' && standaloneTool) {
                return;
            }

            const list = partsByAfterTool.get(currentAfterToolPartId) ?? [];
            list.push(activity);
            partsByAfterTool.set(currentAfterToolPartId, list);
        });
    });

    const activitySegments: TurnActivityGroup[] = [];

    const pickStartAnchor = (segmentParts: TurnActivityRecord[]): string | undefined => {
        if (segmentParts.length === 0) {
            return undefined;
        }

        const countByMessage = new Map<string, number>();
        segmentParts.forEach((activity) => {
            countByMessage.set(activity.messageId, (countByMessage.get(activity.messageId) ?? 0) + 1);
        });

        let firstWithAny: string | undefined;
        for (const message of input.assistantMessages) {
            const count = countByMessage.get(message.info.id) ?? 0;
            if (count > 0 && !firstWithAny) {
                firstWithAny = message.info.id;
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
