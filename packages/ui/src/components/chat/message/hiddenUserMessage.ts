import type { Message, Part } from '@/lib/opencode/model';
import { readPromptOrigin } from '@/lib/opencode/prompt-origin';

import { deriveMessageRole } from './messageRole';
import { isEmptyTextPart, normalizeParts } from './partUtils';
import { normalizeUserDisplayParts } from './normalizeUserDisplayParts';
import { readSourceControlProvider } from '@/lib/source-control/providers/registry';

type UserMessageEntry = { info: Message; parts: Part[] };
const hiddenByEntry = new WeakMap<UserMessageEntry, boolean>();

export const hasVisibleUserMessageContent = (parts: Part[], hasPromptOrigin: boolean): boolean =>
    hasPromptOrigin || parts.some((part) => !isEmptyTextPart(part));

export const isHiddenUserMessage = (
    entry: UserMessageEntry | null | undefined,
): boolean => {
    if (!entry) return false;
    if (!deriveMessageRole(entry.info).isUser) return false;

    const cached = hiddenByEntry.get(entry);
    if (cached !== undefined) {
        return cached;
    }

    const parts = normalizeUserDisplayParts(normalizeParts(entry.parts), readSourceControlProvider);
    const hidden = !hasVisibleUserMessageContent(parts, Boolean(readPromptOrigin(entry.info)));
    hiddenByEntry.set(entry, hidden);
    return hidden;
};
