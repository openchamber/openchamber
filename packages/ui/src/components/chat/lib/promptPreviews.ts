/**
 * The prompt labels the navigator rail and the timeline read.
 *
 * OpenCode v2 delivers a prompt's attached context (a quote, a terminal
 * selection, a failed check, a linked issue) as separate `synthetic` messages
 * ahead of the prompt, so a prompt that is only attached context reaches its
 * `user` message with nothing but an empty text part. Folding that context back
 * on, as the bubble does, is what gives such prompts a label instead of the
 * empty fallback.
 */

import type { Part } from '@/lib/opencode/model';

import { normalizeUserDisplayParts } from '../message/normalizeUserDisplayParts';
import { attachSyntheticContext } from './attachSyntheticContext';
import type { ChatMessageEntry } from './turns/types';

/**
 * A prompt a label can be drawn from: typed text, an attachment, or a folded-in
 * context part. A lone empty text part is not one, so a prompt with nothing to
 * show never becomes a rail tick or a timeline row.
 */
const hasReadablePrompt = (parts: Part[]): boolean =>
    parts.some((part) => part.type !== 'text' || part.text.trim().length > 0);

/**
 * The user messages of `messages` with their injected context folded back on, in
 * timeline order, dropping the ones that carry nothing a label could read. The
 * entries keep their `info`, so callers still have the message id and time.
 */
export const foldPromptEntries = (messages: ChatMessageEntry[]): ChatMessageEntry[] =>
    attachSyntheticContext(messages).filter(
        (message) => message.info.role === 'user' && hasReadablePrompt(message.parts),
    );

// `normalizeUserDisplayParts` allocates a new array on every call. Caching it by
// the folded parts array keeps the map's value identities stable while the
// message is unchanged, so the rail's memo can bail out to its previous map.
const normalizedByFoldedParts = new WeakMap<Part[], Part[]>();

const normalizePromptParts = (parts: Part[]): Part[] => {
    const cached = normalizedByFoldedParts.get(parts);
    if (cached) return cached;
    const normalized = normalizeUserDisplayParts(parts);
    normalizedByFoldedParts.set(parts, normalized);
    return normalized;
};

/**
 * The prompt display parts keyed by user message id, for the navigator rail.
 */
export const buildPromptPreviewsByTurnId = (messages: ChatMessageEntry[]): Map<string, Part[]> => {
    const previews = new Map<string, Part[]>();
    for (const message of foldPromptEntries(messages)) {
        previews.set(message.info.id, normalizePromptParts(message.parts));
    }
    return previews;
};
