import { beforeEach, describe, expect, test } from 'bun:test';

import { MAX_SEEN_MESSAGE_IDS, MessageFreshnessDetector } from './messageFreshness';

import type { Message } from '@/lib/opencode/model';

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

    test('seen set is capped with oldest-first eviction and recent messages stay seen', () => {
        detector.recordSessionStart('session-a');
        const total = MAX_SEEN_MESSAGE_IDS + 100;
        for (let i = 0; i < total; i += 1) {
            detector.shouldAnimateMessage(makeAssistantMessage(`msg-cap-${i}`, Date.now()), 'session-a');
        }

        expect(detector.getDebugInfo().seenMessageIds.size).toBe(MAX_SEEN_MESSAGE_IDS);
        // The oldest entries were evicted; the most recent ones are retained.
        expect(detector.hasBeenAnimated('msg-cap-0')).toBe(false);
        expect(detector.hasBeenAnimated(`msg-cap-${total - 1}`)).toBe(true);
        // A retained recent message must not re-animate.
        expect(detector.shouldAnimateMessage(makeAssistantMessage(`msg-cap-${total - 1}`, Date.now()), 'session-a')).toBe(false);
        expect(detector.getDebugInfo().seenMessageIds.size).toBe(MAX_SEEN_MESSAGE_IDS);
    });

    test('regression #2124 after eviction: an evicted message does not re-animate once its freshness window has expired', () => {
        const originalNow = Date.now;
        let fakeNow = 1_700_000_000_000;
        Date.now = () => fakeNow;
        try {
            detector.recordSessionStart('session-a');
            const evicted = makeAssistantMessage('msg-evicted', fakeNow);

            // First render: the message is fresh and animates.
            expect(detector.shouldAnimateMessage(evicted, 'session-a')).toBe(true);

            // Push enough newer messages through to evict the first id.
            const total = MAX_SEEN_MESSAGE_IDS + 10;
            for (let i = 0; i < total; i += 1) {
                detector.shouldAnimateMessage(makeAssistantMessage(`msg-fill-${i}`, fakeNow), 'session-a');
            }
            expect(detector.hasBeenAnimated('msg-evicted')).toBe(false);

            // Return to the session an hour later. recordSessionStart runs
            // in an effect after render, so the stale session start is still
            // stored; the evicted message must not pass freshness against
            // it now that its freshness window has expired.
            fakeNow += 60 * 60 * 1000;
            expect(detector.shouldAnimateMessage(evicted, 'session-a')).toBe(false);

            // A genuinely new message arriving at the current time, however,
            // still animates even against the stale session start.
            const fresh = makeAssistantMessage('msg-new-arrival', fakeNow);
            expect(detector.shouldAnimateMessage(fresh, 'session-a')).toBe(true);
        } finally {
            Date.now = originalNow;
        }
    });

    test('markMessageAsAnimated is bounded by the same cap', () => {
        const total = MAX_SEEN_MESSAGE_IDS + 5;
        for (let i = 0; i < total; i += 1) {
            detector.markMessageAsAnimated(`msg-marked-${i}`);
        }

        expect(detector.getDebugInfo().seenMessageIds.size).toBe(MAX_SEEN_MESSAGE_IDS);
        expect(detector.hasBeenAnimated('msg-marked-0')).toBe(false);
        expect(detector.hasBeenAnimated(`msg-marked-${total - 1}`)).toBe(true);
    });

    test('getDebugInfo exposes no messageCreationTimes state', () => {
        detector.recordSessionStart('session-a');
        detector.shouldAnimateMessage(makeAssistantMessage('msg-debug', Date.now()), 'session-a');

        expect('messageCreationTimes' in detector.getDebugInfo()).toBe(false);
    });
});
