import { formatMessageText } from '@/lib/messages/messageMarkdown';
import { assistantTextSegments } from '@/lib/messages/messageText';
import { attachSyntheticContext } from '../lib/attachSyntheticContext';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import type { ChatMessageEntry } from '../lib/turns/types';
import { isHiddenUserMessage } from '../message/hiddenUserMessage';
import { deriveMessageRole } from '../message/messageRole';
import { filterVisibleParts } from '../message/partUtils';
import { messageSelectionKey } from '@/stores/useMessageSelectionStore';

type SelectablePrompt = { kind: 'prompt'; key: string; messageId: string; text: string };

export type SelectableAnswer = {
    kind: 'answer';
    key: string;
    messageId: string;
    segments: string[];
    providerID: string | null;
    modelID: string | null;
};

export type SelectableUnit = SelectablePrompt | SelectableAnswer;

const promptText = (message: ChatMessageEntry): string => formatMessageText(filterVisibleParts(message.parts), { user: true });

const answerSegments = (messages: readonly ChatMessageEntry[]): string[] => messages.flatMap((message) => (
    assistantTextSegments(filterVisibleParts(message.parts, { includeReasoning: false }))
));

export const listSelectableUnits = (records: ChatMessageEntry[]): SelectableUnit[] => {
    const { turns } = projectTurnRecords(attachSyntheticContext(records), { mergeHiddenUserTurns: true });
    const units: SelectableUnit[] = [];
    for (const turn of turns) {
        const prompt = turn.userMessage;
        if (deriveMessageRole(prompt.info).isUser && !isHiddenUserMessage(prompt)) {
            const text = promptText(prompt);
            if (text) units.push({ kind: 'prompt', key: messageSelectionKey('prompt', turn.turnId), messageId: prompt.info.id, text });
        }
        const segments = answerSegments(turn.assistantMessages);
        const last = turn.assistantMessages.at(-1);
        if (segments.length === 0 || !last) continue;
        const info = last.info.role === 'assistant' ? last.info : null;
        units.push({
            kind: 'answer',
            key: messageSelectionKey('answer', turn.turnId),
            messageId: last.info.id,
            segments,
            providerID: info?.providerID.trim() || null,
            modelID: info?.modelID.trim() || null,
        });
    }
    return units;
};
