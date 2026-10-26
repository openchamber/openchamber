// Gesture classification for the chat timeline's follow opt-out.
//
// The timeline releases live follow on REAL upward gestures only. Wheel and
// touch carry their direction; this module answers the same question for the
// inputs that do not: which keys mean "scroll up", when a middle-button press
// starts a pan, and when an upward wheel belongs to a nested scroller (a tool
// output box) that can still consume it. Pure functions, no DOM ownership,
// so the rules are testable without a renderer; the one event below carries
// gestures made inside a page frame out to the timeline.

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

// A wheel or swipe over a sandboxed page frame (`openchamber_render`) scrolls
// the timeline, but its events stay in the frame. The frame's owner reports
// the gesture's direction as this event from the frame element, so the
// timeline holding that frame hears it like its own wheel or touch.
const FRAME_SCROLL_EVENT = 'openchamber:frame-scroll';

/** `up` moves toward older content: a wheel up, or a finger dragging down. */
export type FrameScrollDirection = 'up' | 'down';

export function dispatchFrameScroll(frame: HTMLElement, direction: FrameScrollDirection): void {
    frame.dispatchEvent(new CustomEvent<FrameScrollDirection>(FRAME_SCROLL_EVENT, { bubbles: true, detail: direction }));
}

/** Listens for frame scroll gestures inside `container`. */
export function onFrameScroll(container: HTMLElement, listener: (direction: FrameScrollDirection) => void): () => void {
    const handle = (event: Event) => {
        if (event instanceof CustomEvent && (event.detail === 'up' || event.detail === 'down')) listener(event.detail);
    };
    container.addEventListener(FRAME_SCROLL_EVENT, handle);
    return () => container.removeEventListener(FRAME_SCROLL_EVENT, handle);
}

// The reader opened a row (a tool, an agent task, a reasoning block, folded
// work). The row raises this event from its element as it opens, so the
// timeline holding it lets go of the end before the row grows: the content
// opens below the header the reader clicked, instead of the end pulling the
// header up and out of view.
const ROW_EXPAND_EVENT = 'openchamber:row-expand';

export function dispatchRowExpand(row: HTMLElement | null): void {
    row?.dispatchEvent(new CustomEvent(ROW_EXPAND_EVENT, { bubbles: true }));
}

/** Listens for rows the reader opens inside `container`. */
export function onRowExpand(container: HTMLElement, listener: () => void): () => void {
    container.addEventListener(ROW_EXPAND_EVENT, listener);
    return () => container.removeEventListener(ROW_EXPAND_EVENT, listener);
}

// Middle-button press starts the platform's autoscroll pan (Windows/Linux
// Chromium); the pan then scrolls without wheel events, so the press itself is
// the gesture. Inside a nested scroller the pan belongs to that scroller.
export const isMiddleButtonPan = (root: HTMLElement, event: Pick<MouseEvent, 'button' | 'target'>): boolean =>
    event.button === 1 && nestedScrollable(root, event.target) === null;
