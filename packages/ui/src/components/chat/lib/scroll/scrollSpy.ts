export type VisibleTurn = {
    id: string;
    ratio: number;
    top: number;
};

export type OffsetTurn = {
    id: string;
    top: number;
};

type ScrollSpyInput = {
    onActive: (id: string) => void;
    raf?: (cb: FrameRequestCallback) => number;
    caf?: (id: number) => void;
    IntersectionObserver?: typeof globalThis.IntersectionObserver;
    ResizeObserver?: typeof globalThis.ResizeObserver;
    MutationObserver?: typeof globalThis.MutationObserver;
};

export const pickVisibleTurnId = (list: VisibleTurn[], line: number): string | undefined => {
    if (list.length === 0) {
        return undefined;
    }

    const sorted = [...list].sort((a, b) => {
        if (b.ratio !== a.ratio) {
            return b.ratio - a.ratio;
        }

        const distanceA = Math.abs(a.top - line);
        const distanceB = Math.abs(b.top - line);
        if (distanceA !== distanceB) {
            return distanceA - distanceB;
        }

        return a.top - b.top;
    });

    return sorted[0]?.id;
};

export const pickOffsetTurnId = (list: OffsetTurn[], cutoff: number): string | undefined => {
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
    const CtorIO = input.IntersectionObserver ?? globalThis.IntersectionObserver;
    const CtorRO = input.ResizeObserver ?? globalThis.ResizeObserver;
    const CtorMO = input.MutationObserver ?? globalThis.MutationObserver;

    let root: HTMLDivElement | undefined;
    let io: IntersectionObserver | undefined;
    let ro: ResizeObserver | undefined;
    let mo: MutationObserver | undefined;
    let frame: number | undefined;
    let roDebounce: ReturnType<typeof setTimeout> | undefined;
    let active: string | undefined;
    let dirty = true;

    const nodes = new Map<string, HTMLElement>();
    const idByElement = new WeakMap<HTMLElement, string>();
    const visible = new Map<string, { ratio: number; top: number }>();
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

        const line = container.getBoundingClientRect().top + 100;
        const next =
            pickVisibleTurnId(
                [...visible].map(([id, value]) => ({
                    id,
                    ratio: value.ratio,
                    top: value.top,
                })),
                line,
            )
            ?? (() => {
                if (dirty) {
                    refreshOffsets();
                }
                return pickOffsetTurnId(offsets, container.scrollTop + 100);
            })();

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

        io?.disconnect();
        io = undefined;
        if (CtorIO) {
            try {
                io = new CtorIO(
                    (entries) => {
                        for (const entry of entries) {
                            const element = entry.target;
                            if (!(element instanceof HTMLElement)) {
                                continue;
                            }

                            const key = idByElement.get(element);
                            if (!key) {
                                continue;
                            }

                            if (!entry.isIntersecting || entry.intersectionRatio <= 0) {
                                visible.delete(key);
                                continue;
                            }

                            visible.set(key, {
                                ratio: entry.intersectionRatio,
                                top: entry.boundingClientRect.top,
                            });
                        }

                        schedule();
                    },
                    {
                        root: container,
                        threshold: [0, 0.25, 0.5, 0.75, 1],
                    },
                );
            } catch {
                io = undefined;
            }
        }

        if (io) {
            for (const element of nodes.values()) {
                io.observe(element);
            }
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
        visible.clear();
        active = undefined;
        observe();
    };

    const register = (element: HTMLElement, key: string) => {
        const previous = nodes.get(key);
        if (previous && previous !== element) {
            io?.unobserve(previous);
            ro?.unobserve(previous);
        }

        nodes.set(key, element);
        idByElement.set(element, key);
        if (io) {
            io.observe(element);
        }
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

        io?.unobserve(element);
        ro?.unobserve(element);
        nodes.delete(key);
        visible.delete(key);
        dirty = true;
        schedule();
    };

    const markDirty = () => {
        dirty = true;
        schedule();
    };

    const clear = () => {
        for (const element of nodes.values()) {
            io?.unobserve(element);
            ro?.unobserve(element);
        }

        nodes.clear();
        visible.clear();
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
        io?.disconnect();
        ro?.disconnect();
        mo?.disconnect();
        io = undefined;
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
