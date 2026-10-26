// Keeping what the reader looks at in place while the transcript changes
// size around it: a batch of messages mounting above, folded work collapsing.

export const CHAT_SCROLLER_SELECTOR = '[data-scrollbar="chat"]';

// Not wheel: a trackpad sends wheel events for as long as a scroll and its
// momentum last, so a wheel-ended hold lasted one frame and the list's later
// correction threw the reader by the whole batch. The hold is two frames.
const READER_INPUT_EVENTS = ['touchstart', 'pointerdown', 'keydown'] as const;

/**
 * Keeps `element` at viewport position `top` across a size change of its row,
 * such as a batch of messages mounting above it. The list measures the changed
 * row after this commit and, anchored to a visible row it can have cached from
 * before the reader scrolled into this turn, may move the viewport by the same
 * amount a second time. Observed after the list's own measurement, the resize
 * check puts the element back before that frame paints; the frame checks cover
 * a later correction. Touch, pointer or key input ends the hold at once.
 */
export const holdAnchor = (scroller: Element, element: Element, top: number): (() => void) => {
    const align = () => {
        if (!element.isConnected) return;
        const delta = element.getBoundingClientRect().top - top;
        if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
    };
    const resizeObserver = new ResizeObserver(align);
    let frame: number | null = null;
    const stop = () => {
        resizeObserver.disconnect();
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        for (const type of READER_INPUT_EVENTS) scroller.removeEventListener(type, stop);
    };
    align();
    resizeObserver.observe(element.closest('[data-turn-id]') ?? element);
    for (const type of READER_INPUT_EVENTS) scroller.addEventListener(type, stop, { passive: true });
    frame = requestAnimationFrame(() => {
        align();
        frame = requestAnimationFrame(() => {
            align();
            stop();
        });
    });
    return stop;
};
