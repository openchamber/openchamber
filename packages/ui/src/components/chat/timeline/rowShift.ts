const GLIDE_MS = 220;
const GLIDE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

export interface RowShiftStart {
    tops: ReadonlyMap<string, number>;
}

const rowsByKey = (container: HTMLElement): Map<string, HTMLElement> => {
    const rows = new Map<string, HTMLElement>();
    for (const element of container.querySelectorAll<HTMLElement>('[data-list-row]')) if (element.dataset.listRow) rows.set(element.dataset.listRow, element);
    return rows;
};

const carrierOf = (element: HTMLElement): HTMLElement => element.parentElement ?? element;

const running = new WeakMap<HTMLElement, Animation[]>();

const stopRowShift = (container: HTMLElement): void => {
    for (const animation of running.get(container) ?? []) animation.cancel();
    running.delete(container);
};

export const captureRowShift = (container: HTMLElement, keys: ReadonlySet<string>): RowShiftStart | null => {
    stopRowShift(container);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
    const tops = new Map<string, number>();
    for (const [key, element] of rowsByKey(container)) if (keys.has(key)) tops.set(key, element.getBoundingClientRect().top);
    return tops.size > 0 ? { tops } : null;
};

export const playRowShift = (container: HTMLElement, start: RowShiftStart, keys: readonly string[]): void => {
    const elements = rowsByKey(container);
    const shown = keys.flatMap((key) => {
        const element = elements.get(key);
        return element ? [{ key, element, box: element.getBoundingClientRect() }] : [];
    });
    const kept = [...shown].reverse().find(({ key }) => start.tops.has(key));
    const last = shown.at(-1);
    if (!kept || !last) return;
    const delta = (start.tops.get(kept.key) ?? kept.box.top) - kept.box.top;
    if (delta <= 0.5) return;
    const bottom = last.box.bottom;
    const animations = shown.map(({ element, box }) => {
        const hiddenAt = (offset: number) => Math.min(box.height, Math.max(0, box.bottom + offset - bottom));
        const animation = carrierOf(element).animate([
            { transform: `translateY(${delta}px)`, clipPath: `inset(0 -100vw ${hiddenAt(delta)}px -100vw)` },
            { transform: 'translateY(0)', clipPath: 'inset(0 -100vw 0px -100vw)' },
        ], { duration: GLIDE_MS, easing: GLIDE_EASING });
        animation.startTime = document.timeline.currentTime;
        return animation;
    });
    running.set(container, animations);
};
