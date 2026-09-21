// Gesture classification for the chat timeline's follow opt-out.
//
// The timeline releases live follow on REAL upward gestures only. Wheel and
// touch carry their direction; this module answers the same question for the
// inputs that do not: which keys mean "scroll up", when a middle-button press
// starts a pan, and when an upward wheel belongs to a nested scroller (a tool
// output box) that can still consume it. Pure functions, no DOM ownership,
// so the rules are testable without a renderer.

// A nested scroller inside the timeline marks itself with this attribute
// (see ToolPart). Wheel-up over it scrolls the box, not the conversation, for
// as long as the box has room above.
const NESTED_SCROLLABLE_SELECTOR = '[data-scrollable]';

export const isFollowReleaseKey = (
    event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
): boolean => {
    // Modified keys are shortcuts, not navigation.
    if (event.altKey || event.ctrlKey || event.metaKey) return false;
    if (event.key === ' ') return event.shiftKey;
    return event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home';
};

const nestedScrollable = (root: HTMLElement, target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    const nested = target.closest(NESTED_SCROLLABLE_SELECTOR);
    return nested instanceof HTMLElement && nested !== root ? nested : null;
};

// An upward wheel over a nested scroller that still has content above stays
// with that scroller; the timeline must not treat it as leaving the end.
export const nestedScrollableConsumesWheelUp = (root: HTMLElement, target: EventTarget | null): boolean => {
    const nested = nestedScrollable(root, target);
    return nested !== null && nested.scrollTop > 0;
};

// Middle-button press starts the platform's autoscroll pan (Windows/Linux
// Chromium); the pan then scrolls without wheel events, so the press itself is
// the gesture. Inside a nested scroller the pan belongs to that scroller.
export const isMiddleButtonPan = (root: HTMLElement, event: Pick<MouseEvent, 'button' | 'target'>): boolean =>
    event.button === 1 && nestedScrollable(root, event.target) === null;
