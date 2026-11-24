export const SETTLE_QUIET_MS = 10_000;
export const SETTLE_MAX_MS = 20_000;
export const ALIGN_EPSILON_PX = 1;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
const READER_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'focusin'] as const;

export function listenToHeldScroller({ scroller, inputTarget, content, onMoved, onReaderInput }: {
    scroller: HTMLElement | null;
    inputTarget: HTMLElement;
    content: Element | null;
    onMoved: () => void;
    onReaderInput: () => void;
}): () => void {
    const handleKeyDown = (event: KeyboardEvent) => {
        if (SCROLL_KEYS.has(event.key)) onReaderInput();
    };
    const ObserverCtor = globalThis.ResizeObserver;
    const observer = ObserverCtor ? new ObserverCtor(onMoved) : null;
    if (content) observer?.observe(content);
    scroller?.addEventListener('scroll', onMoved, { passive: true });
    for (const event of READER_EVENTS) inputTarget.addEventListener(event, onReaderInput, { passive: true, capture: true });
    inputTarget.addEventListener('keydown', handleKeyDown, true);
    return () => {
        observer?.disconnect();
        scroller?.removeEventListener('scroll', onMoved);
        for (const event of READER_EVENTS) inputTarget.removeEventListener(event, onReaderInput, true);
        inputTarget.removeEventListener('keydown', handleKeyDown, true);
    };
}
