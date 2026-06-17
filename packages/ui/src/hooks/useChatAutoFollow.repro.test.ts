/**
 * Reproduction test for issue #1690: Endless scrolling / chat jumping.
 *
 * Root cause analysis:
 *
 * The auto-follow system in useChatAutoFollow.ts uses a 200ms "programmatic write
 * window" (PROGRAMMATIC_WRITE_WINDOW_MS = 200) that is set every time tickFollow
 * writes scrollTop. During this window, ALL scroll events are swallowed by the
 * handleScrollEvent handler — including genuine USER scrolls.
 *
 * The RAF-based tickFollow loop runs at ~60fps (every ~16ms). Each tick resets the
 * programmatic window to 200ms from now. This means:
 *
 *   - While the follow loop is active, the programmatic window NEVER closes.
 *   - Any user scroll-up attempt during this period is incorrectly classified as
 *     "programmatic" and IGNORED.
 *   - The release-from-user-intent logic (currentTop < previousTop) never fires,
 *     so the state stays 'following'.
 *   - After the loop settles and stops (4 consecutive frames within 0.5px epsilon),
 *     the programmatic window lives on for up to 200ms more.
 *   - If anything restarts the follow loop within that window (e.g., ResizeObserver
 *     from a tiny layout shift, a font load, a virtualizer adjustment), the window
 *     extends and user scrolls continue to be swallowed.
 *   - The user experiences "jumping" — they scroll up, the app ignores it (or
 *     processes it too late), and the follow loop scrolls them back to bottom.
 *
 * This test demonstrates the core issue: user scrolls within the programmatic write
 * window are swallowed, preventing the auto-follow from releasing.
 */

import { describe, test, expect } from 'bun:test';

// Constants that mirror the real ones
const PROGRAMMATIC_WRITE_WINDOW_MS = 200;
const SETTLE_EPSILON = 0.5;
const LERP = 0.18;

describe('Issue #1690: Endless scrolling reproduction', () => {
    /**
     * Scenario: User scrolls up while auto-follow loop is actively scrolling.
     *
     * The tickFollow loop runs every ~16ms (RAF). Each tick:
     *   1. Computes target = scrollHeight - clientHeight
     *   2. Computes delta = target - current
     *   3. Writes scrollTop = current + delta * LERP
     *   4. Sets programmatic write window for 200ms
     *
     * If a user scrolls up within 200ms of any tick, the scroll event is
     * swallowed by the isInProgrammaticWindow() check, and the release
     * never fires.
     */
    test('user scroll-up within programmatic write window is ignored, preventing release', () => {
        // Simulate a scroll container
        let scrollTop = 1200;
        let scrollHeight = 2000;
        const clientHeight = 500;

        // Track programmatic window state
        let programmaticWriteUntil = 0;
        let currentTime = 0;

        const markProgrammaticWrite = () => {
            programmaticWriteUntil = currentTime + PROGRAMMATIC_WRITE_WINDOW_MS;
        };

        const isInProgrammaticWindow = () => {
            return currentTime < programmaticWriteUntil;
        };

        // --- Phase 1: Follow loop is running ---
        // Simulate 3 RAF ticks of the follow loop
        for (let tick = 0; tick < 3; tick++) {
            const target = Math.max(0, scrollHeight - clientHeight);
            const current = scrollTop;
            const delta = target - current;

            if (Math.abs(delta) > SETTLE_EPSILON) {
                scrollTop = current + delta * LERP;
            }
            markProgrammaticWrite();
            currentTime += 16; // ~16ms per RAF frame
        }

        // After 3 ticks (48ms), the programmatic window is active until currentTime + 200ms
        const windowDeadline = programmaticWriteUntil;
        expect(isInProgrammaticWindow()).toBe(true);
        expect(windowDeadline - currentTime).toBeGreaterThan(0);

        // --- Phase 2: User scrolls UP ---
        // At this point, the follow loop has settled but programmatic window is still active.
        // Simulate a user scroll-up event at currentTime + 50ms (still within the 200ms window)
        currentTime += 50;
        expect(isInProgrammaticWindow()).toBe(true);

        const previousScrollTop = scrollTop;

        // User scrolls up by 100px
        const userScrollDelta = -100;
        scrollTop = Math.max(0, scrollTop + userScrollDelta);

        // The scroll event fires. handleScrollEvent checks:
        const programmatic = isInProgrammaticWindow();
        // Since programmatic is true, the handler RETURNS EARLY.
        // The release logic (currentTop < previousTop) is NEVER evaluated.

        expect(programmatic).toBe(true);
        // CRITICAL: The release did NOT happen. Even though the user scrolled up,
        // the auto-follow state remains 'following'.
        // The user's scroll is effectively ignored.

        // The follow loop restarts on the next content change (or ResizeObserver)
        // and scrolls the user back to bottom, creating the "jumping" sensation.
    });

    /**
     * Scenario: Even after the follow loop settles, the 200ms window extends
     * long after the last write, catching unrelated user scrolls.
     */
    test('programmatic write window persists long after follow loop stops', () => {
        let programmaticWriteUntil = 0;
        let currentTime = 0;

        const markProgrammaticWrite = () => {
            programmaticWriteUntil = currentTime + PROGRAMMATIC_WRITE_WINDOW_MS;
        };

        const isInProgrammaticWindow = () => {
            return currentTime < programmaticWriteUntil;
        };

        // Simulate: follow loop writes scrollTop at T=0
        markProgrammaticWrite();

        // Loop settles after 4 frames at 16ms each = 64ms total
        currentTime = 64;

        // Loop stops because settledFramesRef >= SETTLE_FRAMES (4)
        // But programmatic window extends to 0 + 200 = 200ms

        // At T=150ms (86ms AFTER loop stopped), user scrolls up
        currentTime = 150;
        expect(isInProgrammaticWindow()).toBe(true);
        // STILL in programmatic window — scroll is swallowed!

        // At T=250ms (186ms AFTER loop stopped)
        currentTime = 250;
        expect(isInProgrammaticWindow()).toBe(false);
        // Now the window has expired.

        // The 86ms gap (T=64 to T=150) where user scrolls are incorrectly
        // filtered is >5 RAF frames worth of lost user interactions.
        // If any ResizeObserver fires during this gap and restarts the
        // follow loop, the window extends further indefinitely.
    });

    /**
     * Scenario: ResizeObserver restarts the follow loop while the
     * programmatic window is still open, extending it indefinitely.
     * This creates a permanent "lock" where user scrolls are never
     * processed, making the chat feel like it's fighting the user.
     */
    test('ResizeObserver can extend programmatic window indefinitely, locking auto-follow', () => {
        let programmaticWriteUntil = 0;
        let currentTime = 0;
        let followLoopActive = false;

        const markProgrammaticWrite = () => {
            programmaticWriteUntil = currentTime + PROGRAMMATIC_WRITE_WINDOW_MS;
        };

        const isInProgrammaticWindow = () => {
            return currentTime < programmaticWriteUntil;
        };

        // Simulate repeated ResizeObserver → startFollowLoop cycle
        // This represents what happens with virtua Virtualizer layout adjustments

        for (let cycle = 0; cycle < 10; cycle++) {
            // ResizeObserver fires and restarts follow loop
            followLoopActive = true;

            // Follow loop runs for a few ticks
            for (let tick = 0; tick < 5; tick++) {
                markProgrammaticWrite();
                currentTime += 16;
            }

            // Follow loop settles and stops
            followLoopActive = false;

            // But programmatic window is at currentTime + 200ms
            // A ResizeObserver fires from e.g., virtua layout adjustment
            currentTime += 100;

            if (isInProgrammaticWindow()) {
                // User scroll would be swallowed here
            }

            // ResizeObserver fires again, restarting follow loop
            // This keeps the programmatic window alive indefinitely
        }

        // After all cycles, the programmatic window has never closed
        // because each cycle extended it before it could expire
        expect(programmaticWriteUntil).toBeGreaterThan(currentTime);
        // User can never scroll up successfully
    });

    /**
     * Scenario: The follow loop lerp never reaches within SETTLE_EPSILON
     * due to continuous small layout shifts (e.g., virtua item measurement
     * changes, font loading).
     */
    test('follow loop can run indefinitely when scrollHeight oscillates', () => {
        let scrollTop = 100;
        let scrollHeight = 1500;
        const clientHeight = 500;
        let iterationCount = 0;
        const MAX_ITERATIONS = 1000;

        // Simulate a situation where scrollHeight keeps changing slightly
        // (e.g., virtua adjusts spacer heights as items are measured)
        let settledFrames = 0;

        while (iterationCount < MAX_ITERATIONS) {
            iterationCount++;

            const target = Math.max(0, scrollHeight - clientHeight);
            const current = scrollTop;
            const delta = target - current;

            if (Math.abs(delta) <= SETTLE_EPSILON) {
                settledFrames++;
                if (settledFrames >= 4) {
                    // Loop should stop
                    break;
                }
            } else {
                settledFrames = 0;
                scrollTop = current + delta * LERP;

                // Simulate a tiny layout shift from virtua or other component
                // that changes scrollHeight by a small amount
                scrollHeight += 0.3;
            }
        }

        // Bug: With scrollHeight oscillation, the follow loop NEVER settles.
        // Without oscillation it would settle in ~60 iterations.
        // Here it hit the MAX_ITERATIONS guard without ever reaching 4 settled frames.
        expect(iterationCount).toBe(MAX_ITERATIONS);
        // settledFrames never reached 4, confirming the infinite loop
        expect(settledFrames).toBeLessThan(4);

        // The key insight: if scrollHeight oscillates by even 0.5px per frame
        // (e.g., virtua spacer adjustment ±0.5px), the follow loop can run
        // indefinitely because delta never stays within 0.5px for 4 consecutive frames.
        // During this entire time, ALL user scrolls are swallowed by the
        // programmatic write window, making the chat feel like it's fighting the user.
    });
});
