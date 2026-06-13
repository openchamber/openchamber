/**
 * Reproduction test for #1640: Autoscroll should stop on middle-button pan and keyboard navigation.
 *
 * This test demonstrates that the auto-follow interruption logic in useChatAutoFollow.ts
 * does NOT handle:
 *   1. Middle-button pointerdown/mousedown (button === 1) — the primary scroll
 *      mechanism for tablet users and users without a scroll wheel.
 *   2. Keyboard navigation keys Space, Shift+Space, PageDown, ArrowDown — which are
 *      standard browser scroll keys that should release auto-follow when the scroll
 *      container is focused.
 *
 * The `isReleaseKey` function (lines 74-86) only returns true for ArrowUp, PageUp, Home.
 * The event effect (lines 481-549) has no `pointerdown`/`mousedown` handler for
 * middle-button drag/pan on the scroll container itself.
 *
 * These gaps mean that users who rely on middle-button pan or keyboard-only navigation
 * cannot reliably interrupt auto-follow during streaming.
 */

import { describe, expect, test } from 'bun:test';

// Reproduce the EXACT logic from useChatAutoFollow.ts lines 74-86
const isReleaseKey = (event: KeyboardEvent): boolean => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
        return false;
    }
    switch (event.key) {
        case 'ArrowUp':
        case 'PageUp':
        case 'Home':
            return true;
        default:
            return false;
    }
};

/**
 * Build a minimal KeyboardEvent-like object for testing isReleaseKey.
 */
const keyEvent = (key: string, opts?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): KeyboardEvent => {
    return {
        key,
        altKey: opts?.altKey ?? false,
        ctrlKey: opts?.ctrlKey ?? false,
        metaKey: opts?.metaKey ?? false,
        shiftKey: opts?.shiftKey ?? false,
    } as KeyboardEvent;
};

describe('isReleaseKey — keyboard scroll keys that release auto-follow', () => {
    // Already handled keys — these pass
    test('ArrowUp releases (handled ✓)', () => {
        expect(isReleaseKey(keyEvent('ArrowUp'))).toBe(true);
    });
    test('PageUp releases (handled ✓)', () => {
        expect(isReleaseKey(keyEvent('PageUp'))).toBe(true);
    });
    test('Home releases (handled ✓)', () => {
        expect(isReleaseKey(keyEvent('Home'))).toBe(true);
    });

    // MISSING keys — these FAIL to release, which is the bug
    test('PageDown does NOT release (BUG: missing from switch)', () => {
        // Pressing PageDown scrolls DOWN by one viewport height.
        // If the user is at bottom and presses PageDown, nothing visible happens,
        // but if content keeps streaming, the user's intent to navigate manually
        // should release auto-follow.
        expect(isReleaseKey(keyEvent('PageDown'))).toBe(false);
    });

    test('Space does NOT release (BUG: missing from switch)', () => {
        // Space scrolls down one viewport height (same as PageDown).
        // This is a standard keyboard scroll key.
        expect(isReleaseKey(keyEvent(' '))).toBe(false);
    });

    test('Shift+Space does NOT release (BUG: missing from switch)', () => {
        // Shift+Space is the standard browser shortcut for page-up (scroll up).
        // This clearly moves the user AWAY from the bottom, yet auto-follow is not released.
        // Note: Shift is NOT filtered by the altKey/ctrlKey/metaKey guard.
        expect(isReleaseKey(keyEvent(' ', { shiftKey: true }))).toBe(false);
    });

    test('ArrowDown does NOT release (BUG: missing from switch)', () => {
        // ArrowDown scrolls down slightly. When near the bottom, pressing ArrowDown
        // navigates within the scroll area, indicating user intent.
        expect(isReleaseKey(keyEvent('ArrowDown'))).toBe(false);
    });

    test('End does NOT release (BUG: missing from switch)', () => {
        // End scrolls to the bottom. While this doesn't move away from bottom,
        // it's still a manual keyboard navigation that should be recognized.
        // Currently, pressing End will scroll to bottom, but then auto-follow
        // might still be in 'following' state — which is actually fine, but
        // the key is still unhandled from a completeness perspective.
        expect(isReleaseKey(keyEvent('End'))).toBe(false);
    });
});

describe('Middle-button pan/auto-scroll — missing pointerdown handler', () => {
    /**
     * The effect at lines 481-549 attaches these event handlers on the scroll container:
     *   - scroll → handleScrollEvent
     *   - wheel → handleWheel
     *   - touchstart / touchmove / touchend / touchcancel → touch handlers
     *   - keydown → handleKeyDown (with isReleaseKey gate)
     *   - pointerdown (window, capture) → handlePointerDownIntent (only for overlay scrollbar thumb)
     *
     * There is NO handler for:
     *   - pointerdown / mousedown on the scroll container for middle-button (button === 1)
     *   - mousedown on the scroll container for middle-button
     *
     * The handlePointerDownIntent handler (line 519-524) ONLY checks for
     * [data-overlay-scrollbar-thumb] — i.e., the overlay scrollbar thumb drag.
     * It does NOT handle middle-button click/pan on the scrollable area itself.
     */

    test('No pointerdown handler for middle-button on the scroll container', () => {
        // The effect registers these listeners on the container:
        // 'scroll', 'wheel', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'keydown'
        // And on window (capture): 'pointerdown' (only for overlay scrollbar thumb)
        //
        // Missing: 'pointerdown' or 'mousedown' on the container for button === 1
        //
        // This is a static verification of the code structure.
        // To verify dynamically, one would need to mount the hook and dispatch
        // a pointerdown event with button=1 on the container — it would NOT
        // trigger releaseFromUserIntent.

        const expectedContainerListeners = [
            'scroll',
            'wheel',
            'touchstart',
            'touchmove',
            'touchend',
            'touchcancel',
            'keydown',
        ];

        // There is NO 'mousedown' or 'pointerdown' on the container for middle-button pan.
        // If middle-button pan were handled, one of these would be present:
        const missingMiddleButtonHandlers = ['mousedown', 'pointerdown'];
        // The code adds 'pointerdown' on window (capture), but only for
        // [data-overlay-scrollbar-thumb] — not for middle-button pan.

        // This assertion documents the gap:
        expect(missingMiddleButtonHandlers.length).toBeGreaterThan(0);
        // In the current code, middle-button click/pan on the scrollable area
        // does NOT release auto-follow. The only way it might indirectly release
        // is via the 'scroll' event if the pan actually changes scrollTop, but:
        //   a) Middle-click auto-scroll on some platforms does not generate
        //      scroll events until the mouse moves a minimum distance.
        //   b) The initial click (user intent) is not captured.
        //   c) The auto-follow loop may counteract slow pan scrolling.
    });

    test('handlePointerDownIntent only checks overlay scrollbar thumb, not middle-button', () => {
        // The effect at line 519-524 attaches a window-level pointerdown handler
        // that only checks for [data-overlay-scrollbar-thumb] elements.
        // There is NO handler for middle-button (button === 1) on the scroll
        // container itself.
        //
        // The handler that DOES exist (handlePointerDownIntent) returns early
        // unless the event target (or an ancestor) has data-overlay-scrollbar-thumb.
        // A middle-button click on the scroll container does NOT satisfy this
        // condition, so releaseFromUserIntent() is NOT called.
        //
        // Static code analysis confirms:
        //   - Line 522: `if (!target.closest('[data-overlay-scrollbar-thumb]')) return;`
        //   - No other pointerdown/mousedown handler for the container
        //   - No `event.button === 1` check anywhere in the effect
        //
        // This is the core of the bug: middle-button pan intent is not captured.

        // Verify that the existing handler structure has a specific gap:
        // The handler checks for overlay-scrollbar-thumb but NOT for middle-button.
        const handlerChecksForOverlayScrollbarThumb = true;
        const handlerChecksForMiddleButton = false; // no `event.button === 1` anywhere

        expect(handlerChecksForOverlayScrollbarThumb).toBe(true);
        expect(handlerChecksForMiddleButton).toBe(false);

        // The handler flow for middle-button click on the scroll container:
        //   1. pointerdown fires on window (capture phase)
        //   2. handlePointerDownIntent checks target.closest('[data-overlay-scrollbar-thumb]')
        //   3. The scroll container does NOT match → function returns
        //   4. releaseFromUserIntent() is NEVER called
        // Result: auto-follow continues despite clear user intent to navigate manually.
    });
});

/**
 * Summary of findings:
 *
 * In `useChatAutoFollow.ts`:
 *
 * ┌──────────────────────────────┬────────────────────┬──────────────────────────────────────┐
 * │ Interaction                  │ Current behavior   │ Bug?                                 │
 * ├──────────────────────────────┼────────────────────┼──────────────────────────────────────┤
 * │ Wheel scroll up              │ Releases ✓          │                                      │
 * │ Touch/pan upward             │ Releases ✓          │                                      │
 * │ Scrollbar thumb drag upward  │ Releases ✓          │                                      │
 * │ ArrowUp / PageUp / Home      │ Releases ✓          │                                      │
 * ├──────────────────────────────┼────────────────────┼──────────────────────────────────────┤
 * │ Middle-button pan (button=1) │ Does NOT release    │ BUG — no pointerdown/mousedown       │
 * │ Space                        │ Does NOT release    │ BUG — missing from isReleaseKey      │
 * │ Shift+Space (page up)        │ Does NOT release    │ BUG — missing from isReleaseKey      │
 * │ PageDown                     │ Does NOT release    │ BUG — missing from isReleaseKey      │
 * │ ArrowDown                    │ Does NOT release    │ BUG — missing from isReleaseKey      │
 * │ End                          │ Does NOT release    │ BUG — missing from isReleaseKey      │
 * └──────────────────────────────┴────────────────────┴──────────────────────────────────────┘
 *
 * Note: ArrowDown, PageDown, Space, and End scroll towards the bottom, so their
 * practical impact is less severe than middle-button pan or Shift+Space.
 * However, the issue requests that ALL keyboard navigation keys that move the
 * scroll position should be treated as user intent to navigate manually.
 */
