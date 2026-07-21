/**
 * Tests for issue #2124: chat entry animation replays on session switch.
 *
 * `MessageFreshnessDetector` decides, once, whether an assistant message is new
 * enough to play its entry animation. The replay happened because a message that
 * was judged "fresh" was never recorded as shown, so after a session switch (the
 * chat viewport remounts and `recordSessionStart` runs only in a post-render
 * effect, leaving a stale start time in place) the same message re-passed the
 * freshness check. The fix records the message from a committed effect in
 * `ChatMessage` via `markMessageAsAnimated`; marking after commit (rather than
 * inside the memoized `shouldAnimateMessage` call) avoids flipping the decision to
 * false under React StrictMode's double-invoked render.
 *
 * These tests guard the detector-level contract the fix relies on: the freshness
 * query must stay decision-stable when re-run without an intervening mark, and a
 * mark must permanently prevent re-animation. The `ChatMessage` effect wiring
 * itself is not exercised here (the repo's React tests use SSR, which runs no
 * effects); it is covered by type-check and review.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { MessageFreshnessDetector } from './messageFreshness';
import type { Message } from '@opencode-ai/sdk/v2';

function makeMessage(overrides: Partial<Message> = {}): Message {
    return {
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        time: { created: Date.now() + 10_000 },
        ...overrides,
    } as unknown as Message;
}

describe('MessageFreshnessDetector - issue #2124', () => {
    let detector: MessageFreshnessDetector;

    beforeEach(() => {
        detector = MessageFreshnessDetector.getInstance();
        detector.clearAll();
    });

    test('evaluating a fresh message is a pure query and does not record it (safe under StrictMode double-render)', () => {
        const session = 'session-A';
        detector.recordSessionStart(session);
        const fresh = makeMessage({ id: 'fresh-1' });

        // Recording during shouldAnimateMessage would flip the result to false on
        // StrictMode's second render invocation and suppress the first animation.
        expect(detector.shouldAnimateMessage(fresh, session)).toBe(true);
        expect(detector.hasBeenAnimated('fresh-1')).toBe(false);
        expect(detector.shouldAnimateMessage(fresh, session)).toBe(true);
    });

    test('marking a fresh message after render stops it replaying on a stale-timing session revisit', () => {
        const session = 'session-A';
        detector.recordSessionStart(session);
        const fresh = makeMessage({ id: 'fresh-2' });

        // First visit: eligible to animate.
        expect(detector.shouldAnimateMessage(fresh, session)).toBe(true);

        // Reproduce #2124: switching away and back remounts the viewport, but
        // recordSessionStart runs in a post-render effect, so the first render
        // after the switch still sees the stale (still-fresh) start time. Absent a
        // record of the earlier animation, the message re-animates.
        expect(detector.shouldAnimateMessage(fresh, session)).toBe(true);

        // The fix: ChatMessage marks the message in a committed effect after it
        // renders. Once marked, the stale-timing revisit no longer re-animates.
        detector.markMessageAsAnimated(fresh.id, fresh.time.created);
        expect(detector.shouldAnimateMessage(fresh, session)).toBe(false);
    });
});

describe('MessageFreshnessDetector - contract', () => {
    let detector: MessageFreshnessDetector;

    beforeEach(() => {
        detector = MessageFreshnessDetector.getInstance();
        detector.clearAll();
    });

    test('non-assistant messages never animate', () => {
        detector.recordSessionStart('session-A');
        const user = makeMessage({ id: 'user-1', role: 'user' });

        expect(detector.shouldAnimateMessage(user, 'session-A')).toBe(false);
    });

    test('a historical (non-fresh) message never animates', () => {
        detector.recordSessionStart('session-A');
        const old = makeMessage({ id: 'old-1', time: { created: Date.now() - 60_000 } as Message['time'] });

        expect(detector.shouldAnimateMessage(old, 'session-A')).toBe(false);
        expect(detector.shouldAnimateMessage(old, 'session-A')).toBe(false);
    });

    test('a message without recorded session timing never animates', () => {
        const message = makeMessage({ id: 'no-timing-1' });

        expect(detector.shouldAnimateMessage(message, 'session-A')).toBe(false);
    });
});
