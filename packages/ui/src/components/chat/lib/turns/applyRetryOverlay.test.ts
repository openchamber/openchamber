import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, UserMessage } from '@/lib/opencode/model';
import { assistantErrorNotice } from '@/lib/messages/assistantError';

import { readScheduledRetry } from '../../sessionErrorNoticeState';
import { applyRetryOverlay } from './applyRetryOverlay';
import type { ChatMessageEntry } from './types';

// The OpenChamber server turns `session.retry.scheduled` into a `retry`
// session status, which `ChatContainer` hands to the list as this overlay.
// OpenCode 2.x also records the retry on the step it will retry, where the
// retry notice under the transcript reads it.
const REASON = 'Internal Server Error';
const overlay = { sessionId: 'ses_1', message: REASON, fallbackTimestamp: 0 };

const prompt: ChatMessageEntry = {
    info: { id: 'msg_1', sessionID: 'ses_1', role: 'user', time: { created: 1_000 } } satisfies UserMessage,
    parts: [],
};

const openStep = (retry?: AssistantMessage['retry']): ChatMessageEntry => {
    const info: AssistantMessage = { id: 'msg_2', sessionID: 'ses_1', role: 'assistant', time: { created: 2_000 }, agent: 'build', providerID: 'fake', modelID: 'fake-one' };
    if (retry) info.retry = retry;
    return { info, parts: [] };
};

/** The box the transcript prints on each message, in order. */
const boxes = (messages: ChatMessageEntry[]): string[] => messages.flatMap((message) => {
    const notice = assistantErrorNotice(message.info);
    return notice ? [notice.text] : [];
});

/** Whether `SessionRetryNotice` has a retry to show for these messages. */
const noticeShowsRetry = (messages: ChatMessageEntry[]): boolean => readScheduledRetry(messages.map((message) => message.info)) !== null;

describe('applyRetryOverlay', () => {
    test('leaves a step that carries its own retry to the retry notice, so the reason shows once', () => {
        const messages = [prompt, openStep({ attempt: 2, at: 9_000, error: { type: 'APIError', message: REASON, status: 500 } })];

        const result = applyRetryOverlay(messages, overlay);

        expect(noticeShowsRetry(messages)).toBe(true);
        expect(result).toBe(messages);
        expect(boxes(result)).toEqual([]);
    });

    test('keeps the box for a retry status on a step that carries no retry, where the notice shows nothing', () => {
        const messages = [prompt, openStep()];

        const result = applyRetryOverlay(messages, overlay);

        expect(noticeShowsRetry(messages)).toBe(false);
        expect(boxes(result)).toEqual([`Opencode failed to send a message. Retry attempt info: ${REASON}`]);
    });

    test('keeps the box for a retry status that arrives before the step does', () => {
        const messages = [prompt];

        const result = applyRetryOverlay(messages, overlay);

        expect(noticeShowsRetry(messages)).toBe(false);
        expect(result.map((message) => message.info.id)).toEqual(['msg_1', 'synthetic_retry_notice_ses_1']);
        expect(boxes(result)).toEqual([`Opencode failed to send a message. Retry attempt info: ${REASON}`]);
    });
});
