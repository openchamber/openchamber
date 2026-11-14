import type { Part } from '@/lib/opencode/model';
import { readSourceControlProvider } from '@/lib/source-control/providers/registry';
import { attachSyntheticContext } from '../lib/attachSyntheticContext';
import { getNormalizedMessageForDisplay } from '../lib/messageDisplayNormalization';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import type { ChatMessageEntry } from '../lib/turns/types';
import { isHiddenUserMessage } from '../message/hiddenUserMessage';
import { normalizeUserDisplayParts } from '../message/normalizeUserDisplayParts';
import { conversationSelectionKey } from './selectionStore';
import type { SelectedConversationMessage } from './selectionMarkdown';

export const hasConversationExportContent = (parts: readonly Part[]): boolean => parts.some((part) => (
    (part.type === 'text' && part.text.trim().length > 0) || part.type === 'file'
));

const exportParts = (parts: Part[]) => ({
    segments: parts.flatMap((part) => part.type === 'text' && part.text.trim() ? [part.text] : []),
    attachments: parts.flatMap((part) => part.type === 'file' ? [{ name: part.filename || part.mime, url: part.url }] : []),
});

/** Reads selected content from records, including text whose DOM is folded or virtualized away. */
export const collectSelectedConversationMessages = (
    messages: ChatMessageEntry[],
    selected: ReadonlySet<string>,
): SelectedConversationMessage[] => {
    const displayMessages = attachSyntheticContext(messages.map(getNormalizedMessageForDisplay));
    const projection = projectTurnRecords(displayMessages, { mergeHiddenUserTurns: true });
    const result: SelectedConversationMessage[] = [];
    const turnsByOpeningId = new Map(projection.turns.map((turn) => [turn.userMessageId, turn]));
    for (const message of displayMessages) {
        const turn = turnsByOpeningId.get(message.info.id);
        if (turn) {
            const userKey = conversationSelectionKey('user', turn.userMessageId);
            if (selected.has(userKey) && message.info.role === 'user' && !isHiddenUserMessage(message)) {
                result.push({ key: userKey, role: 'user', ...exportParts(normalizeUserDisplayParts(message.parts, readSourceControlProvider)) });
            }
            const assistantKey = conversationSelectionKey('assistant', turn.turnId);
            if (selected.has(assistantKey)) {
                const parts = turn.assistantMessages.flatMap((entry) => entry.parts);
                if (hasConversationExportContent(parts)) result.push({ key: assistantKey, role: 'assistant', ...exportParts(parts) });
            }
        }
    }
    return result;
};
