import { describe, expect, test } from 'bun:test';

import { assistantErrorNotice } from '@/lib/messages/assistantError';
import type { AssistantMessage, StructuredError, TextPart, UserMessage } from '@/lib/opencode/model';

import { applyRetryOverlay } from './applyRetryOverlay';
import type { ChatMessageEntry } from './types';
import type { RetryOverlay } from '../../timeline/types';

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

        expect(assistantErrorNotice(displayed[1].info)).toEqual({
            text: 'Opencode failed to send a message. Retry attempt info: Retrying in 2s (attempt 2)',
        });
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
