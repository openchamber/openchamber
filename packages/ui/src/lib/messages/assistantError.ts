/**
 * What a turn's recorded error says in the transcript.
 *
 * Pressing Stop is not a send failure: OpenCode records the interruption on the
 * assistant message as an error, and the chat used to print that error through
 * the generic "failed to send message" branch. This module names the shapes
 * that mean "the user stopped this", so the transcript can say so, and it owns
 * every other reading of that error so the sentence a person sees is decided
 * in one place.
 */

import { z } from 'zod';

import type { Message } from '@/lib/opencode/model';

import { isLikelyProviderAuthFailure, PROVIDER_AUTH_FAILURE_MESSAGE } from './providerAuthError';

export const STOPPED_TURN_MESSAGE = 'The running turn was stopped before OpenCode could send the next message.';

/** OpenCode's structured name for an interrupted step. */
const ABORT_ERROR_NAME = 'MessageAbortedError';

/**
 * The two details that mean a stop on their own: the local close this client
 * writes when it finalizes an interrupted turn (`aborted`), and the text
 * OpenCode records for the same event (`Step interrupted`).
 *
 * Only the whole detail counts. A dropped stream reads "Connection aborted" or
 * "Stream aborted by the provider", and calling those a user stop would hide
 * the reason the turn actually ended.
 */
const STOPPED_DETAILS: ReadonlySet<string> = new Set(['aborted', 'step interrupted']);

const normalizeDetail = (detail: string): string => (
  detail.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '')
);

export const isStoppedTurnError = (name: string | undefined, detail: string): boolean => {
  if (name === ABORT_ERROR_NAME) {
    return true;
  }
  return STOPPED_DETAILS.has(normalizeDetail(detail));
};

/**
 * The error OpenCode attached to a message, decoded once at the boundary.
 *
 * A live event names the failure `name`; the stored v2 error keeps it in
 * `type`; older payloads wrap the text in `data.message`. Anything else on the
 * message is ignored, so a payload this build does not recognise reads as "no
 * error" instead of as a guessed message.
 */
const assistantErrorPayload = z.object({
    name: z.string().optional(),
    type: z.string().optional(),
    message: z.string().optional(),
    data: z.object({ message: z.string().optional() }).optional(),
});

type AssistantErrorDetail = {
    name?: string;
    detail: string;
};

const readAssistantErrorDetail = (info: Message): AssistantErrorDetail | null => {
    // Only an assistant message can carry a turn's error; the other roles have
    // no such field, so reading one would mean inventing it.
    if (info.role !== 'assistant') {
        return null;
    }
    const parsed = assistantErrorPayload.safeParse(info.error);
    if (!parsed.success) {
        return null;
    }
    const { name, type, message, data } = parsed.data;
    const errorName = name ?? type;
    const detail = data?.message || message || errorName;
    return detail ? { name: errorName, detail } : null;
};

type AssistantErrorNotice = { text: string };

/**
 * The sentence the transcript prints for a message's recorded error, or null
 * when the message carries none worth showing.
 */
export const assistantErrorNotice = (info: Message): AssistantErrorNotice | null => {
    const errorDetail = readAssistantErrorDetail(info);
    if (!errorDetail) {
        return null;
    }
    const { name: errorName, detail } = errorDetail;
    if (errorName === 'SessionRetry') {
        return { text: `Opencode failed to send a message. Retry attempt info: ${detail}` };
    }
    if (isLikelyProviderAuthFailure(detail)) {
        return { text: PROVIDER_AUTH_FAILURE_MESSAGE };
    }
    if (isStoppedTurnError(errorName, detail)) {
        return { text: STOPPED_TURN_MESSAGE };
    }
    return { text: `Opencode failed to send message with error: ${detail}` };
};
