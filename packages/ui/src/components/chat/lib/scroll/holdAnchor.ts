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

const readerPlaceHolds = new WeakMap<Element, { align: () => void; stop: () => void }>();
const listAnchorRows = new WeakMap<Element, () => Element | null>();

/**
 * Names, for the timeline scroller, the row the list keeps in place when rows
 * change size, or null while it keeps none (the reader is held on the end).
 */
export const registerListAnchorRow = (scroller: Element, resolve: () => Element | null): (() => void) => {
    listAnchorRows.set(scroller, resolve);
    return () => {
        if (listAnchorRows.get(scroller) === resolve) listAnchorRows.delete(scroller);
    };
};

/**
 * Keeps what the reader looks at in place while the blocks of a long answer
 * mount and unmount around it (`markdownWindow`): a block drawn for the first
 * time comes in at its real height, not its estimate. The list keeps its
 * anchor row in place and moves the viewport for every row above it changing
 * size, so only a change inside the anchor row, above the reader, is left: its
 * topmost drawn block in view is held there, which no such change resizes.
 * While the reader is held on the end, the list keeps nothing and the end
 * holds them.
 */
export const holdReaderPlace = (scroller: HTMLElement): void => {
    // A hold still waiting for its change settles it first: a second change
    // in the same frame would otherwise take the moved place as the start.
    const previous = readerPlaceHolds.get(scroller);
    previous?.align();
    previous?.stop();
    const row = listAnchorRows.get(scroller)?.();
    if (!row) return;
    const view = scroller.getBoundingClientRect();
    let anchor: { element: Element; top: number } | null = null;
    for (const block of row.querySelectorAll('[data-oc-block-index]:not([data-oc-block-placeholder])')) {
        const rect = block.getBoundingClientRect();
        if (rect.bottom <= view.top || rect.top >= view.bottom) continue;
        if (!anchor || rect.top < anchor.top) anchor = { element: block, top: rect.top };
    }
    if (!anchor) return;
    // Where the anchor sits in its row: a scroll the reader makes meanwhile,
    // and the list moving the row and the viewport alike, leave it alone.
    const element = anchor.element;
    const offsetInRow = () => element.getBoundingClientRect().top - row.getBoundingClientRect().top;
    let place = offsetInRow();
    const align = () => {
        if (!element.isConnected) return;
        const now = offsetInRow();
        if (Math.abs(now - place) > 0.5) scroller.scrollTop += now - place;
        place = now;
    };
    const resizeObserver = new ResizeObserver(align);
    resizeObserver.observe(row);
    // A change asked for from a scroll event commits after this frame's
    // animation callbacks: the hold lasts into the next frame.
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => stop()); });
    const stop = () => {
        resizeObserver.disconnect();
        cancelAnimationFrame(frame);
        if (readerPlaceHolds.get(scroller) === hold) readerPlaceHolds.delete(scroller);
    };
    const hold = { align, stop };
    readerPlaceHolds.set(scroller, hold);
};
