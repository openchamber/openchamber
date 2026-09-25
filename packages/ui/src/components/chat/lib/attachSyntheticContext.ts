/**
 * Folds the non-conversation messages OpenCode v2 injects around a prompt back
 * into the timeline the user reads.
 *
 * A send delivers each composer context item (an inline comment, terminal
 * output, a failed PR check, a linked issue) as its own `synthetic` message
 * right before the prompt, carrying the structured payload in its metadata.
 * Server plugins inject `synthetic` messages too, with no metadata; those are
 * prompt plumbing the user never wrote.
 *
 * So: the contiguous run of synthetic messages immediately before a user
 * message belongs to that message. The ones carrying context metadata come
 * back as text parts on the user message, which is exactly where v1 kept them,
 * so they render as context chips inside the user bubble. Everything else the
 * timeline never shows is dropped here instead of rendering as an empty row.
 */

import type { Part, TextPart } from '@/lib/opencode/model';
import { readContextPart } from '@/lib/messages/contextParts';

import { isSkippedTimelineRole } from './timelineRoles';
import type { ChatMessageEntry } from './turns/types';

const contextPartFromSyntheticMessage = (message: ChatMessageEntry): TextPart => {
    const info = message.info;
    const text = info.role === 'synthetic' ? info.text : '';
    return {
        id: `ctx:${info.id}`,
        sessionID: info.sessionID,
        messageID: info.id,
        type: 'text',
        text,
        metadata: info.metadata,
    };
};

/**
 * Merged user entries are cached by their source entry so an unchanged message
 * keeps its identity across renders: turn projection reuses a turn only while
 * its user message is the same object.
 */
type MergedEntry = { contextParts: Part[]; merged: ChatMessageEntry };
const mergedByUserEntry = new WeakMap<ChatMessageEntry, MergedEntry>();

const sameParts = (left: Part[], right: Part[]): boolean => {
    if (left.length !== right.length) return false;
    return left.every((part, index) => part === right[index]);
};

const withContextParts = (message: ChatMessageEntry, contextParts: Part[]): ChatMessageEntry => {
    const cached = mergedByUserEntry.get(message);
    if (cached && sameParts(cached.contextParts, contextParts)) {
        return cached.merged;
    }
    const merged: ChatMessageEntry = { ...message, parts: [...contextParts, ...message.parts] };
    mergedByUserEntry.set(message, { contextParts, merged });
    return merged;
};

/** Context parts built from one synthetic message, cached by that message. */
const contextPartBySyntheticEntry = new WeakMap<ChatMessageEntry, Part>();

export const attachSyntheticContext = (messages: ChatMessageEntry[]): ChatMessageEntry[] => {
    if (!messages.some((message) => isSkippedTimelineRole(message.info.role))) {
        return messages;
    }

    const result: ChatMessageEntry[] = [];
    let pendingContext: Part[] = [];

    for (const message of messages) {
        const role = message.info.role;

        if (role === 'synthetic') {
            if (readContextPart({ type: 'text', metadata: message.info.metadata })) {
                let part = contextPartBySyntheticEntry.get(message);
                if (!part) {
                    part = contextPartFromSyntheticMessage(message);
                    contextPartBySyntheticEntry.set(message, part);
                }
                pendingContext.push(part);
            }
            continue;
        }

        if (isSkippedTimelineRole(role)) continue;

        if (role === 'user' && pendingContext.length > 0) {
            result.push(withContextParts(message, pendingContext));
            pendingContext = [];
            continue;
        }

        // Anything else ends the run: context only belongs to the user message
        // it was sent with.
        pendingContext = [];
        result.push(message);
    }

    return result;
};
