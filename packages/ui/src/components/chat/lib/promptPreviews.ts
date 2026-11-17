
import type { Part } from '@/lib/opencode/model';
import { readSourceControlProvider } from '@/lib/source-control/providers/registry';

import { normalizeUserDisplayParts } from '../message/normalizeUserDisplayParts';
import { attachSyntheticContext } from './attachSyntheticContext';
import type { ChatMessageEntry } from './turns/types';

const hasReadablePrompt = (parts: Part[]): boolean =>
    parts.some((part) => part.type !== 'text' || part.text.trim().length > 0);

export const foldPromptEntries = (messages: ChatMessageEntry[]): ChatMessageEntry[] =>
    attachSyntheticContext(messages).filter(
        (message) => message.info.role === 'user' && hasReadablePrompt(message.parts),
    );

const normalizedByFoldedParts = new WeakMap<Part[], Part[]>();

const normalizePromptParts = (parts: Part[]): Part[] => {
    const cached = normalizedByFoldedParts.get(parts);
    if (cached) return cached;
    const normalized = normalizeUserDisplayParts(parts, readSourceControlProvider);
    normalizedByFoldedParts.set(parts, normalized);
    return normalized;
};

export const buildPromptPreviewsByTurnId = (messages: ChatMessageEntry[]): Map<string, Part[]> => {
    const previews = new Map<string, Part[]>();
    for (const message of foldPromptEntries(messages)) {
        previews.set(message.info.id, normalizePromptParts(message.parts));
    }
    return previews;
};
