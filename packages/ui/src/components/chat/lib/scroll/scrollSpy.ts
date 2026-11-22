import { cancelWhenLayoutSettled, isLayoutAnimating, runWhenLayoutSettled } from '@/lib/layoutAnimation';

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

const READ_LINE_VIEWPORT_FACTOR = 0.5;

const BOTTOM_ANCHOR_MIN_PX = 48;
const BOTTOM_ANCHOR_VIEWPORT_FACTOR = 0.1;

const isInBottomAnchorZone = (container: HTMLDivElement): boolean => {
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceFromBottom <= Math.max(BOTTOM_ANCHOR_MIN_PX, container.clientHeight * BOTTOM_ANCHOR_VIEWPORT_FACTOR);
};

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

    const nodes = new Map<HTMLElement, string>();
    let offsets: OffsetTurn[] = [];

    const schedule = () => {
        if (frame !== undefined) {
            return;
        }
        if (isLayoutAnimating()) {
            runWhenLayoutSettled(schedule);
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
        offsets = [...nodes].map(([element, id]) => ({
            id,
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

        const next = isInBottomAnchorZone(container)
            ? offsets[offsets.length - 1]?.id
            : pickOffsetTurnId(
                offsets,
                container.scrollTop + container.clientHeight * READ_LINE_VIEWPORT_FACTOR,
            );
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
            for (const element of nodes.keys()) {
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

    const register = (element: HTMLElement, id: string) => {
        nodes.set(element, id);
        if (ro) {
            ro.observe(element);
        }
        dirty = true;
        schedule();
    };

    const unregister = (element: HTMLElement) => {
        if (!nodes.has(element)) {
            return;
        }

        ro?.unobserve(element);
        nodes.delete(element);
        dirty = true;
        schedule();
    };

    const markDirty = () => {
        dirty = true;
        schedule();
    };

    const clear = () => {
        for (const element of nodes.keys()) {
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
        cancelWhenLayoutSettled(schedule);
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
