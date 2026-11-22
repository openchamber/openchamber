import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, UserMessage, StructuredError, TextPart } from '@/lib/opencode/model';
import { assistantErrorNotice } from '@/lib/messages/assistantError';
import { readScheduledRetry } from '../../sessionErrorNoticeState';
import { applyRetryOverlay } from './applyRetryOverlay';
import type { ChatMessageEntry } from './types';
import type { RetryOverlay } from '../../timeline/types';


// The OpenChamber server turns `session.retry.scheduled` into a `retry`
// session status, which `ChatContainer` hands to the list as this overlay.
// OpenCode 2.x also records the retry on the step it will retry, where the
// retry notice under the transcript reads it.
const REASON = 'Internal Server Error';
const overlay: RetryOverlay = { sessionId: 'ses_1', lastIdleAt: null, notice: { message: REASON, fallbackTimestamp: 0 } };

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

// ---- upstream tests ----

const SESSION_ID = 'ses_current';
const RETRY_MESSAGE = 'Retrying in 2s (attempt 2)';
const CONNECTION_ERROR: StructuredError = { type: 'provider.transport', message: 'ECONNRESET' };

const userMessage = (id: string, sessionId = SESSION_ID): ChatMessageEntry => ({
    info: {
        id,
        sessionID: sessionId,
        role: 'user',
        time: { created: 1 },
    } satisfies UserMessage,
    parts: [],
});

const assistantMessage = (
    id: string,
    options: {
        sessionId?: string;
        time?: AssistantMessage['time'];
        error?: StructuredError;
        retry?: AssistantMessage['retry'];
    } = {},
): ChatMessageEntry => {
    const { sessionId = SESSION_ID, time = { created: 2 }, ...messageState } = options;
    return {
        info: {
            id,
            sessionID: sessionId,
            role: 'assistant',
            time,
            agent: 'build',
            providerID: 'provider',
            modelID: 'model',
            ...messageState,
        } satisfies AssistantMessage,
        parts: [
            {
                id: `${id}_part`,
                sessionID: sessionId,
                messageID: id,
                type: 'text',
                text: 'Partial response',
            } satisfies TextPart,
        ],
    };
};

const activeRetry: RetryOverlay = {
    sessionId: SESSION_ID,
    lastIdleAt: 1,
    notice: { message: RETRY_MESSAGE, fallbackTimestamp: 10 },
};
const busyRetry: RetryOverlay = { sessionId: SESSION_ID, lastIdleAt: 1 };

describe('applyRetryOverlay', () => {
    test('suppresses only the matching active retry error in the display copy', () => {
        const previousUser = userMessage('msg_previous_user');
        const previousAssistant = assistantMessage('msg_previous_assistant', { error: CONNECTION_ERROR });
        const currentUser = userMessage('msg_current_user');
        const currentAssistant = assistantMessage('msg_current_assistant', {
            error: CONNECTION_ERROR,
            retry: { attempt: 2, at: 10, error: CONNECTION_ERROR },
        });
        const messages = [previousUser, previousAssistant, currentUser, currentAssistant];

        const displayed = applyRetryOverlay(messages, activeRetry);

        expect(displayed[3].parts).toBe(currentAssistant.parts);
        expect(assistantErrorNotice(displayed[1].info)).toEqual({
            text: 'Opencode failed to send message with error: ECONNRESET',
        });
        expect(assistantErrorNotice(displayed[3].info)).toBeNull();
        expect(assistantErrorNotice(currentAssistant.info)).toEqual({
            text: 'Opencode failed to send message with error: ECONNRESET',
        });
    });

    test('keeps retry suppression through busy and restores the terminal error at idle', () => {
        const currentAssistant = assistantMessage('msg_terminal', {
            time: { created: 2, completed: 20 },
            error: CONNECTION_ERROR,
            retry: { attempt: 2, at: 20, error: CONNECTION_ERROR },
        });
        const messages = [userMessage('msg_user'), currentAssistant];

        const retrying = applyRetryOverlay(messages, {
            sessionId: SESSION_ID,
            lastIdleAt: 10,
            notice: { message: RETRY_MESSAGE, fallbackTimestamp: 10 },
        });
        const busy = applyRetryOverlay(messages, { sessionId: SESSION_ID, lastIdleAt: 10 });
        const idle = applyRetryOverlay(messages, null);

        expect(assistantErrorNotice(retrying[1].info)).toBeNull();
        expect(assistantErrorNotice(busy[1].info)).toBeNull();
        expect(assistantErrorNotice(idle[1].info)).toEqual({
            text: 'Opencode failed to send message with error: ECONNRESET',
        });
    });

    test('suppresses an active retry without an explicit fallback notice', () => {
        const currentAssistant = assistantMessage('msg_retrying', {
            time: { created: 2, completed: 20 },
            error: CONNECTION_ERROR,
            retry: { attempt: 2, at: 20, error: CONNECTION_ERROR },
        });

        const displayed = applyRetryOverlay(
            [userMessage('msg_user'), currentAssistant],
            { sessionId: SESSION_ID, lastIdleAt: 10 },
        );

        expect(assistantErrorNotice(displayed[1].info)).toBeNull();
    });

    test('treats a working retry as current before the session has an idle marker', () => {
        const currentAssistant = assistantMessage('msg_retrying', {
            time: { created: 2, completed: 20 },
            error: CONNECTION_ERROR,
            retry: { attempt: 2, at: 20, error: CONNECTION_ERROR },
        });

        const displayed = applyRetryOverlay(
            [userMessage('msg_user'), currentAssistant],
            { sessionId: SESSION_ID, lastIdleAt: null },
        );

        expect(assistantErrorNotice(displayed[1].info)).toBeNull();
    });

    test('keeps a stopped retry error visible when compact becomes busy without a new user', () => {
        const stoppedAt = 10;
        const idleAt = 20;
        const stoppedAssistant = assistantMessage('msg_stopped', {
            time: { created: 2, completed: stoppedAt },
            error: CONNECTION_ERROR,
            retry: { attempt: 2, at: stoppedAt, error: CONNECTION_ERROR },
        });
        const messages = [userMessage('msg_user'), stoppedAssistant];

        const displayed = applyRetryOverlay(messages, { sessionId: SESSION_ID, lastIdleAt: idleAt });

        expect(assistantErrorNotice(displayed[1].info)).toEqual({
            text: 'Opencode failed to send message with error: ECONNRESET',
        });
    });

    test('keeps pre-output fallback for an explicit overlay and adds none for busy alone', () => {
        const currentAssistant = assistantMessage('msg_retrying', {
            retry: { attempt: 2, at: 10, error: CONNECTION_ERROR },
        });
        const messages = [userMessage('msg_user'), currentAssistant];

        const displayed = applyRetryOverlay(messages, activeRetry);
        const busy = applyRetryOverlay(messages, busyRetry);
        const waiting = applyRetryOverlay([userMessage('msg_waiting')], busyRetry);
        const synthetic = applyRetryOverlay([userMessage('msg_synthetic')], activeRetry);

        // The open step carries its own retry, which SessionRetryNotice shows under the transcript.
        expect(displayed).toBe(messages);
        expect(assistantErrorNotice(busy[1].info)).toBeNull();
        expect(waiting).toHaveLength(1);
        expect(assistantErrorNotice(synthetic[1].info)).toEqual({
            text: 'Opencode failed to send a message. Retry attempt info: Retrying in 2s (attempt 2)',
        });
    });

    test('keeps historical retry errors visible and leaves a later unmarked step terminal', () => {
        const previousAssistant = assistantMessage('msg_previous_assistant', {
            error: CONNECTION_ERROR,
            retry: { attempt: 2, at: 10, error: CONNECTION_ERROR },
        });
        const currentAssistant = assistantMessage('msg_current_assistant', { error: CONNECTION_ERROR });
        const messages = [
            userMessage('msg_previous_user'),
            previousAssistant,
            userMessage('msg_current_user'),
            currentAssistant,
        ];

        const displayed = applyRetryOverlay(messages, { sessionId: SESSION_ID, lastIdleAt: 20 });

        expect(assistantErrorNotice(displayed[1].info)).toEqual({
            text: 'Opencode failed to send message with error: ECONNRESET',
        });
        expect(assistantErrorNotice(displayed[3].info)).toEqual({
            text: 'Opencode failed to send message with error: ECONNRESET',
        });
    });

    test('keeps unmatched assistant errors terminal and retains the retry fallback', () => {
        const otherSessionAssistant = assistantMessage('msg_other_session', {
            sessionId: 'ses_other',
            error: CONNECTION_ERROR,
            retry: { attempt: 2, at: 10, error: CONNECTION_ERROR },
        });
        const messages = [userMessage('msg_user'), otherSessionAssistant];

        const displayed = applyRetryOverlay(messages, activeRetry);

        expect(assistantErrorNotice(displayed[1].info)).toEqual({
            text: 'Opencode failed to send message with error: ECONNRESET',
        });

        const fallback = applyRetryOverlay(
            [userMessage('msg_fallback_user'), assistantMessage('msg_fallback')],
            activeRetry,
        );
        expect(assistantErrorNotice(fallback[1].info)).toEqual({
            text: 'Opencode failed to send a message. Retry attempt info: Retrying in 2s (attempt 2)',
        });
    });
});
