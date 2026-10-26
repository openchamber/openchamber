import { isInvisibleText } from '@/lib/invisibleText';
import type {
    ChatMessageEntry,
    TurnActivityRecord,
    TurnPartRecord,
} from './types';

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
    if (typeof text === 'string' && !isInvisibleText(text)) {
        return text;
    }
    const content = (part as { content?: unknown }).content;
    if (typeof content === 'string' && !isInvisibleText(content)) {
        return content;
    }
    return undefined;
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
}

interface ProjectActivityResult {
    activityParts: TurnActivityRecord[];
    hasTools: boolean;
    hasReasoning: boolean;
}

/** The turn's tool calls and non-empty reasoning, in the order they ran. */
export const projectTurnActivity = (input: ProjectActivityInput): ProjectActivityResult => {
    const activityParts: TurnActivityRecord[] = [];
    let hasTools = false;
    let hasReasoning = false;

    input.assistantMessages.forEach((message) => {
        message.parts.forEach((part, partIndex) => {
            let kind: TurnActivityRecord['kind'];
            if (part.type === 'tool') {
                hasTools = true;
                kind = 'tool';
            } else if (part.type === 'reasoning' && getPartText(part)) {
                hasReasoning = true;
                kind = 'reasoning';
            } else {
                return;
            }

            activityParts.push({
                ...buildTurnPartRecord(input.turnId, message.info.id, part, partIndex),
                kind,
            });
        });
    });

    return {
        activityParts,
        hasTools,
        hasReasoning,
    };
};
