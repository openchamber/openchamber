import { beforeEach, describe, expect, test } from 'bun:test';

import { MessageFreshnessDetector } from './messageFreshness';

import type { Message } from '@opencode-ai/sdk/v2';

const makeAssistantMessage = (id: string, created: number): Message =>
    ({
        id,
        role: 'assistant',
        sessionID: 'session-a',
        time: { created },
    }) as unknown as Message;

describe('MessageFreshnessDetector.shouldAnimateMessage', () => {
    let detector: MessageFreshnessDetector;

    beforeEach(() => {
        detector = MessageFreshnessDetector.getInstance();
        detector.clearAll();
    });

    test('fresh message animates once and is recorded as seen', () => {
        detector.recordSessionStart('session-a');
        const message = makeAssistantMessage('msg-fresh', Date.now());

        expect(detector.shouldAnimateMessage(message, 'session-a')).toBe(true);
        expect(detector.hasBeenAnimated('msg-fresh')).toBe(true);
    });

    test('regression #2124: fresh message does not re-animate when returning to the session', () => {
        detector.recordSessionStart('session-a');
        const message = makeAssistantMessage('msg-fresh', Date.now());

        // First visit: the message is fresh and animates.
        expect(detector.shouldAnimateMessage(message, 'session-a')).toBe(true);

        // User switches away and back; ChatViewport remounts and re-evaluates
        // before recordSessionStart runs again, so the old session start time
        // is still in effect. The message must not animate a second time.
        expect(detector.shouldAnimateMessage(message, 'session-a')).toBe(false);
    });

    test('stale history message never animates and is recorded as seen', () => {
        detector.recordSessionStart('session-a');
        const message = makeAssistantMessage('msg-old', Date.now() - 60_000);

        expect(detector.shouldAnimateMessage(message, 'session-a')).toBe(false);
        expect(detector.hasBeenAnimated('msg-old')).toBe(true);
        expect(detector.shouldAnimateMessage(message, 'session-a')).toBe(false);
    });

    test('message evaluated without a recorded session start does not animate and is recorded', () => {
        const message = makeAssistantMessage('msg-no-session', Date.now());

        expect(detector.shouldAnimateMessage(message, 'session-a')).toBe(false);
        expect(detector.hasBeenAnimated('msg-no-session')).toBe(true);

        // Recording the session start afterwards must not resurrect the animation.
        detector.recordSessionStart('session-a');
        expect(detector.shouldAnimateMessage(message, 'session-a')).toBe(false);
    });

    test('non-assistant messages never animate', () => {
        detector.recordSessionStart('session-a');
        const message = {
            id: 'msg-user',
            role: 'user',
            sessionID: 'session-a',
            time: { created: Date.now() },
        } as unknown as Message;

        expect(detector.shouldAnimateMessage(message, 'session-a')).toBe(false);
    });

    test('a new fresh message still animates after older fresh messages were seen', () => {
        detector.recordSessionStart('session-a');
        const first = makeAssistantMessage('msg-first', Date.now());
        const second = makeAssistantMessage('msg-second', Date.now());

        expect(detector.shouldAnimateMessage(first, 'session-a')).toBe(true);
        expect(detector.shouldAnimateMessage(second, 'session-a')).toBe(true);
        expect(detector.shouldAnimateMessage(second, 'session-a')).toBe(false);
    });
});
