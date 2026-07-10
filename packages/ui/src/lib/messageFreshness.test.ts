/**
 * Reproduction test for issue #2124: Chat animation replays on session switching
 *
 * Root cause: MessageFreshnessDetector.shouldAnimateMessage() does NOT add
 * a message to `seenMessageIds` when it returns `true` (i.e., when the message
 * is considered "fresh"). This means those messages are NOT tracked as
 * "already animated". When the user switches sessions and comes back,
 * the same session start time is still in the map (useEffect that calls
 * recordSessionStart hasn't run yet during the first render after switch),
 * so these previously-fresh messages are re-identified as "fresh" and
 * animate again.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { MessageFreshnessDetector } from './messageFreshness';
import type { Message } from '@opencode-ai/sdk/v2';

describe('MessageFreshnessDetector - Issue #2124 reproduction', () => {
    let detector: MessageFreshnessDetector;

    beforeEach(() => {
        // Get a fresh singleton for each test by clearing all state
        detector = MessageFreshnessDetector.getInstance();
        detector.clearAll();
    });

    function makeMessage(overrides: Partial<Message> = {}): Message {
        return {
            id: 'msg-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
            time: { created: Date.now() + 10000 }, // created in the future relative to session start
            ...overrides,
        } as unknown as Message;
    }

    test('BUG REPRODUCTION: fresh message is not tracked in seenMessageIds, so it re-animates on subsequent session visit', () => {
        const sessionA = 'session-A';

        // Simulate first visit to session A
        detector.recordSessionStart(sessionA);

        // Create a "fresh" message (created just after session start)
        const freshMessage = makeMessage({ id: 'fresh-msg-1' });

        // First evaluation: should return true (message is fresh)
        const firstResult = detector.shouldAnimateMessage(freshMessage, sessionA);
        expect(firstResult).toBe(true);

        // BUG: After returning true, the message should have been tracked
        // but it is NOT in seenMessageIds
        expect(detector.hasBeenAnimated('fresh-msg-1')).toBe(false);
        // ^^ THIS IS THE BUG - the message ID was never added to seenMessageIds

        // Simulate switching away from and back to session A
        // (recordSessionStart would be called again in a useEffect, updating the
        // session start time, but during the initial render the OLD start time is used)
        // Actually let's simulate the exact scenario:
        // The session start time is NOT updated yet (useEffect running after render)

        // Second evaluation (same session, same message):
        // shouldAnimateMessage should return false since it was already "seen"
        const secondResult = detector.shouldAnimateMessage(freshMessage, sessionA);
        // BUG: It returns true AGAIN because the message was never added to seenMessageIds
        // AND the session start time hasn't changed, so the time check still passes
        expect(secondResult).toBe(true);
        // ^^ THIS IS THE BUG - message animates again on re-visit
    });

    test('EXPECTED BEHAVIOR: previously animated message should not animate on re-visit', () => {
        const sessionA = 'session-A';

        // First visit
        detector.recordSessionStart(sessionA);

        // A message that was already seen (non-fresh, e.g. loaded from history)
        const oldMessage = makeMessage({
            id: 'old-msg-1',
            time: { created: Date.now() - 60000 }, // created 60s before session start
        });

        // Non-fresh messages ARE properly tracked
        const firstOld = detector.shouldAnimateMessage(oldMessage, sessionA);
        expect(firstOld).toBe(false);
        expect(detector.hasBeenAnimated('old-msg-1')).toBe(true);

        // Re-visit: correctly returns false
        const secondOld = detector.shouldAnimateMessage(oldMessage, sessionA);
        expect(secondOld).toBe(false);

        // Now test the fresh message case with proper tracking
        const freshMessage = makeMessage({ id: 'fresh-msg-2' });
        const firstFresh = detector.shouldAnimateMessage(freshMessage, sessionA);
        expect(firstFresh).toBe(true);

        // If the message were properly tracked (i.e., markMessageAsAnimated called),
        // the second call would return false
        detector.markMessageAsAnimated('fresh-msg-2', freshMessage.time.created);
        const secondFresh = detector.shouldAnimateMessage(freshMessage, sessionA);
        expect(secondFresh).toBe(false);
        // ^^ This is the EXPECTED (fixed) behavior
    });

    test('session switch timing issue: recordSessionStart in useEffect allows re-animation during render', () => {
        const sessionA = 'session-A';

        // First visit
        detector.recordSessionStart(sessionA);

        const freshMessage = makeMessage({ id: 'fresh-msg-3' });

        // First evaluation: fresh (not tracked)
        expect(detector.shouldAnimateMessage(freshMessage, sessionA)).toBe(true);
        expect(detector.hasBeenAnimated('fresh-msg-3')).toBe(false);

        // Simulate switching to session B then back to A
        // When switching back to A, the useEffect with recordSessionStart
        // hasn't run yet (runs after render), so sessionStartTimes['A'] still
        // has the OLD value from first visit
        //
        // The message.created is still > old sessionStartTime - 5s,
        // so it looks "fresh" again

        expect(detector.shouldAnimateMessage(freshMessage, sessionA)).toBe(true);
        // ^^ BUG: Still returns true because message was never tracked

        // Now simulate the useEffect running (recordSessionStart updates the time)
        detector.recordSessionStart(sessionA);

        // Now the session start time is updated to NOW, so the same message
        // would NOT be fresh anymore (created is way in the past relative to now)
        // But it would still not be in seenMessageIds!
        // The time check would fail but only because we forced recordSessionStart
        // In reality, the timing depends on whether the message was created recently

        // Let's create a scenario where even with the updated start time,
        // the time check would still pass (i.e., message was created recently
        // relative to the new session start)
        const recentMessage = makeMessage({
            id: 'recent-msg',
            time: { created: Date.now() - 1000 }, // created 1s ago
        });

        detector.recordSessionStart(sessionA); // start time = NOW

        // Even with updated start time, recentMessage is not in seenMessageIds
        expect(detector.hasBeenAnimated('recent-msg')).toBe(false);

        // isFresh = recentMessage.created > sessionStartTime - 5000
        // = (Date.now() - 1000) > (Date.now() - 5000) = true
        // So it would return true!
        const result = detector.shouldAnimateMessage(recentMessage, sessionA);
        expect(result).toBe(true);
        // BUG: Even after session re-entry with updated start time,
        // messages that were never tracked can still be "fresh"
    });
});
