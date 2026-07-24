type OffsetTurn = {
    id: string;
    top: number;
};

type ScrollSpyInput = {
    onActive: (id: string) => void;
    raf?: (cb: FrameRequestCallback) => number;
    caf?: (id: number) => void;
    ResizeObserver?: typeof globalThis.ResizeObserver;
    MutationObserver?: typeof globalThis.MutationObserver;
};

// Reading line offset below the container top. The active turn is the last
// one whose top edge sits at or above this line — a monotonic rule that stays
// stable while scrolling inside a long turn (no visibility-ratio flip-flop).
const READ_LINE_OFFSET_PX = 100;

// When the container is scrolled to (or almost to) the bottom, the last turn
// is what the user is reading even if it is too short for its top edge to
// ever cross the reading line — force-activate it in that case.
const BOTTOM_ANCHOR_EPSILON_PX = 8;

const pickOffsetTurnId = (list: OffsetTurn[], cutoff: number): string | undefined => {
    if (list.length === 0) {
        return undefined;
    }

    let lo = 0;
    let hi = list.length - 1;
    let out = 0;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const top = list[mid]?.top;
        if (top === undefined) {
            break;
        }

        if (top <= cutoff) {
            out = mid;
            lo = mid + 1;
            continue;
        }

        hi = mid - 1;
    }

    return list[out]?.id;
};

export const createScrollSpy = (input: ScrollSpyInput) => {
    const raf = input.raf ?? requestAnimationFrame;
    const caf = input.caf ?? cancelAnimationFrame;
    const CtorRO = input.ResizeObserver ?? globalThis.ResizeObserver;
    const CtorMO = input.MutationObserver ?? globalThis.MutationObserver;

    let root: HTMLDivElement | undefined;
    let ro: ResizeObserver | undefined;
    let mo: MutationObserver | undefined;
    let frame: number | undefined;
    let roDebounce: ReturnType<typeof setTimeout> | undefined;
    let active: string | undefined;
    let dirty = true;

    const nodes = new Map<string, HTMLElement>();
    let offsets: OffsetTurn[] = [];

    const schedule = () => {
        if (frame !== undefined) {
            return;
        }
        frame = raf(() => {
            frame = undefined;
            update();
        });
    };

    const refreshOffsets = () => {
        const container = root;
        if (!container) {
            offsets = [];
            dirty = false;
            return;
        }

        const baseTop = container.getBoundingClientRect().top;
        offsets = [...nodes].map(([key, element]) => ({
            id: key,
            top: element.getBoundingClientRect().top - baseTop + container.scrollTop,
        }));
        offsets.sort((a, b) => a.top - b.top);
        dirty = false;
    };

    const update = () => {
        const container = root;
        if (!container) {
            return;
        }

        if (dirty) {
            refreshOffsets();
        }

        const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
        const next = distanceFromBottom <= BOTTOM_ANCHOR_EPSILON_PX
            ? offsets[offsets.length - 1]?.id
            : pickOffsetTurnId(offsets, container.scrollTop + READ_LINE_OFFSET_PX);
        if (!next || next === active) {
            return;
        }

        active = next;
        input.onActive(next);
    };

    const observe = () => {
        const container = root;
        if (!container) {
            return;
        }

        clearTimeout(roDebounce);
        roDebounce = undefined;
        ro?.disconnect();
        ro = undefined;
        if (CtorRO) {
            ro = new CtorRO(() => {
                clearTimeout(roDebounce);
                roDebounce = setTimeout(() => {
                    dirty = true;
                    schedule();
                }, 100);
            });
            ro.observe(container);
            for (const element of nodes.values()) {
                ro.observe(element);
            }
        }

        mo?.disconnect();
        mo = undefined;
        if (CtorMO) {
            mo = new CtorMO(() => {
                dirty = true;
                schedule();
            });
            const moConfig: MutationObserverInit = {
                subtree: true,
                childList: true,
            };
            if (!CtorRO) {
                moConfig.characterData = true;
                moConfig.characterDataOldValue = false;
            }
            mo.observe(container, moConfig);
        }

        dirty = true;
        schedule();
    };

    const setContainer = (element?: HTMLDivElement) => {
        if (root === element) {
            return;
        }

        root = element;
        active = undefined;
        observe();
    };

    const register = (element: HTMLElement, key: string) => {
        const previous = nodes.get(key);
        if (previous && previous !== element) {
            ro?.unobserve(previous);
        }

        nodes.set(key, element);
        if (ro) {
            ro.observe(element);
        }
        dirty = true;
        schedule();
    };

    const unregister = (key: string) => {
        const element = nodes.get(key);
        if (!element) {
            return;
        }

        ro?.unobserve(element);
        nodes.delete(key);
        dirty = true;
        schedule();
    };

    const markDirty = () => {
        dirty = true;
        schedule();
    };

    const clear = () => {
        for (const element of nodes.values()) {
            ro?.unobserve(element);
        }

        nodes.clear();
        offsets = [];
        active = undefined;
        dirty = true;
    };

    const destroy = () => {
        if (frame !== undefined) {
            caf(frame);
        }
        frame = undefined;
        clearTimeout(roDebounce);
        roDebounce = undefined;
        clear();
        ro?.disconnect();
        mo?.disconnect();
        ro = undefined;
        mo = undefined;
        root = undefined;
    };

    return {
        setContainer,
        register,
        unregister,
        onScroll: schedule,
        markDirty,
        clear,
        destroy,
        getActiveId: () => active,
    };
};
