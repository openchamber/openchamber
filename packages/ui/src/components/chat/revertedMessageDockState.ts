import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import type { State } from '@/sync/types';

export type RevertedMessageRecord = {
    message: Message & { role: 'user' };
    parts: Part[];
};

export type RevertedMessageDockState = {
    revertMessageID?: string;
    records: RevertedMessageRecord[];
};

const EMPTY_PARTS: Part[] = [];
const EMPTY_REVERTED_RECORDS: RevertedMessageRecord[] = [];

export const EMPTY_REVERTED_MESSAGE_DOCK_STATE: RevertedMessageDockState = {
    revertMessageID: undefined,
    records: EMPTY_REVERTED_RECORDS,
};

const isUserMessage = (message: Message): message is Message & { role: 'user' } => {
    return message.role === 'user';
};

const areRecordsEqual = (left: RevertedMessageRecord[], right: RevertedMessageRecord[]): boolean => {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index]?.message !== right[index]?.message || left[index]?.parts !== right[index]?.parts) {
            return false;
        }
    }
    return true;
};

export const buildRevertedMessageDockState = (
    state: Pick<State, 'session' | 'message' | 'part'>,
    sessionId: string | null,
    previous: RevertedMessageDockState = EMPTY_REVERTED_MESSAGE_DOCK_STATE,
): RevertedMessageDockState => {
    if (!sessionId) {
        return EMPTY_REVERTED_MESSAGE_DOCK_STATE;
    }

    const session = state.session.find((item) => item.id === sessionId);
    const revertMessageID = (session as { revert?: { messageID?: string } } | undefined)?.revert?.messageID;
    if (!revertMessageID) {
        return EMPTY_REVERTED_MESSAGE_DOCK_STATE;
    }

    const messages = state.message[sessionId] ?? [];
    const records: RevertedMessageRecord[] = [];
    for (const message of messages) {
        if (!isUserMessage(message) || message.id < revertMessageID) {
            continue;
        }
        records.push({
            message,
            parts: state.part[message.id] ?? EMPTY_PARTS,
        });
    }

    const next = records.length === 0 ? EMPTY_REVERTED_RECORDS : records;
    if (previous.revertMessageID === revertMessageID && areRecordsEqual(previous.records, next)) {
        return previous;
    }

    return {
        revertMessageID,
        records: next,
    };
};
