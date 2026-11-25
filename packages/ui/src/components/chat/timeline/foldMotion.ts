const DURATION_MS = 220;
const SAMPLES = 14;
const MAX_TRAVEL_PX = 2400;

const ease = (progress: number): number => 1 - (1 - progress) ** 3;

type Box = { top: number; height: number };

export interface FoldMotionStart {
    anchorKey: string;
    boxes: ReadonlyMap<string, Box>;
    closingKeys: ReadonlySet<string>;
    ghosts: ReadonlyMap<string, HTMLElement>;
}

const rowElements = (container: HTMLElement): HTMLElement[] => (
    [...container.querySelectorAll<HTMLElement>('[data-list-row]')]
);

const boxOf = (element: HTMLElement): Box => {
    const { top, height } = element.getBoundingClientRect();
    return { top, height };
};

const onScreen = (box: Box, container: Box): boolean => box.top < container.top + container.height && box.top + box.height > container.top;

const runningMotions = new WeakMap<HTMLElement, () => void>();

export const stopFoldMotion = (container: HTMLElement): void => {
    runningMotions.get(container)?.();
    runningMotions.delete(container);
};

export const captureFoldMotion = (container: HTMLElement, anchorKey: string, closingKeys: ReadonlySet<string>): FoldMotionStart | null => {
    stopFoldMotion(container);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
    const frame = boxOf(container);
    const boxes = new Map<string, Box>();
    const ghosts = new Map<string, HTMLElement>();
    for (const element of rowElements(container)) {
        const key = element.dataset.listRow;
        if (!key) continue;
        const box = boxOf(element);
        boxes.set(key, box);
        if (closingKeys.has(key) && onScreen(box, frame)) {
            const clone = element.cloneNode(true);
            if (clone instanceof HTMLElement) ghosts.set(key, clone);
        }
    }
    return boxes.has(anchorKey) ? { anchorKey, boxes, closingKeys, ghosts } : null;
};

const sampled = (frameAt: (progress: number) => Keyframe): Keyframe[] => (
    Array.from({ length: SAMPLES + 1 }, (_, index) => frameAt(ease(index / SAMPLES)))
);

const FOOTER_KEY = 'footer';

const carrierOf = (element: HTMLElement): HTMLElement => (
    element.dataset.listRow === FOOTER_KEY ? element : element.parentElement ?? element
);

const play = (element: HTMLElement, frameAt: (progress: number) => Keyframe): Animation => {
    const animation = element.animate(sampled(frameAt), { duration: DURATION_MS, easing: 'linear', fill: 'both' });
    animation.startTime = document.timeline.currentTime;
    return animation;
};

const playRow = (element: HTMLElement, frameAt: (progress: number) => Keyframe): Animation => play(carrierOf(element), frameAt);

const clipBelow = (box: Box, edge: number): string => {
    const hidden = Math.min(box.height, Math.max(0, box.top + box.height - edge));
    return `inset(0 -100vw ${hidden}px -100vw)`;
};

const IDENTITY_ATTRIBUTES = [
    'id', 'data-list-row', 'data-row-key', 'data-turn-row', 'data-turn-id', 'data-scroll-spy-id', 'data-message-id', 'data-message-slice',
    'data-message-row', 'data-message-hoisted', 'data-reasoning-message-id', 'data-chat-quote-root', 'data-live-turn-activity',
];

const stripIdentity = (ghost: HTMLElement): void => {
    for (const element of [ghost, ...ghost.querySelectorAll('*')]) {
        for (const name of IDENTITY_ATTRIBUTES) element.removeAttribute(name);
    }
    for (const embed of ghost.querySelectorAll('iframe, video, audio, embed, object')) embed.remove();
};

const closedHeightOf = ({ boxes, closingKeys }: FoldMotionStart, foldBottom: number, shownKeys: ReadonlyMap<string, HTMLElement>): number => {
    let bottom = foldBottom;
    for (const key of closingKeys) {
        const box = shownKeys.has(key) ? undefined : boxes.get(key);
        if (box) bottom = Math.max(bottom, box.top + box.height);
    }
    return Math.min(MAX_TRAVEL_PX, bottom - foldBottom);
};

type RowBox = { key: string; element: HTMLElement; box: Box };

const openAnimations = (start: FoldMotionStart, after: readonly RowBox[], anchorShift: number, foldTop: number, frame: Box): Animation[] => {
    const opened = after.filter(({ key }) => !start.boxes.has(key));
    const moved = after.filter(({ key }) => start.boxes.has(key));
    const firstMoved = moved[0];
    const firstBefore = firstMoved ? start.boxes.get(firstMoved.key) : undefined;
    const openedHeight = opened.reduce((bottom, { box }) => Math.max(bottom, box.top + box.height), foldTop) - foldTop;
    const distance = Math.min(MAX_TRAVEL_PX, firstMoved && firstBefore ? firstMoved.box.top - firstBefore.top - anchorShift : openedHeight);
    if (distance < 1) return [];
    const animations: Animation[] = [];
    for (const { element, box, key } of moved) {
        const before = start.boxes.get(key);
        if (!before || !(onScreen(box, frame) || onScreen(before, frame))) continue;
        animations.push(playRow(element, (progress) => ({ transform: `translateY(${-distance * (1 - progress)}px)` })));
    }
    for (const { element, box } of opened) {
        if (onScreen(box, frame)) animations.push(playRow(element, (progress) => ({ clipPath: clipBelow(box, foldTop + distance * progress), opacity: progress })));
    }
    return animations;
};

const closeAnimations = (start: FoldMotionStart, rows: readonly RowBox[], overlay: HTMLElement, anchorShift: number, foldTop: number, closedHeight: number, frame: Box): Animation[] => {
    const animations: Animation[] = [];
    for (const { element, box } of rows) {
        const offset = box.top >= foldTop - 1 ? closedHeight - anchorShift : -anchorShift;
        if (Math.abs(offset) < 1 || !(onScreen(box, frame) || onScreen({ top: box.top + offset, height: box.height }, frame))) continue;
        animations.push(playRow(element, (progress) => ({ transform: `translateY(${offset * (1 - progress)}px)` })));
    }
    const foldBottomBefore = foldTop - anchorShift;
    for (const [key, ghost] of start.ghosts) {
        const before = start.boxes.get(key);
        if (!before || rows.some((row) => row.key === key)) continue;
        stripIdentity(ghost);
        Object.assign(ghost.style, { position: 'absolute', insetInline: '0', top: `${before.top - frame.top}px`, height: `${before.height}px`, overflow: 'hidden', pointerEvents: 'none' });
        overlay.append(ghost);
        const inFold = { top: before.top - foldBottomBefore, height: before.height };
        animations.push(play(ghost, (progress) => ({
            transform: `translateY(${anchorShift * progress}px)`,
            clipPath: clipBelow(inFold, closedHeight * (1 - progress)),
            opacity: 1 - progress,
        })));
    }
    return animations;
};

const createOverlay = (container: HTMLElement): HTMLElement => {
    const overlay = document.createElement('div');
    overlay.inert = true;
    overlay.setAttribute('aria-hidden', 'true');
    Object.assign(overlay.style, {
        position: 'absolute', overflow: 'hidden', pointerEvents: 'none',
        top: `${container.offsetTop}px`, left: `${container.offsetLeft}px`, width: `${container.clientWidth}px`, height: `${container.clientHeight}px`,
    });
    return overlay;
};

export const playFoldMotion = (container: HTMLElement, start: FoldMotionStart): void => {
    const frame = boxOf(container);
    const elements = new Map<string, HTMLElement>();
    for (const element of rowElements(container)) if (element.dataset.listRow) elements.set(element.dataset.listRow, element);
    const anchor = elements.get(start.anchorKey);
    const anchorBefore = start.boxes.get(start.anchorKey);
    if (!anchor || !anchorBefore) return;
    const anchorBox = boxOf(anchor);
    const foldTop = anchorBox.top + anchorBox.height;
    const anchorShift = anchorBox.top - anchorBefore.top;
    const rows = [...elements].map(([key, element]) => ({ key, element, box: boxOf(element) })).sort((left, right) => left.box.top - right.box.top);
    const closedHeight = closedHeightOf(start, anchorBefore.top + anchorBefore.height, elements);

    stopFoldMotion(container);
    const overlay = createOverlay(container);
    const content = container.querySelector<HTMLElement>('.legend-list-content-container');
    const animations = closedHeight >= 1
        ? closeAnimations(start, rows, overlay, anchorShift, foldTop, closedHeight, frame)
        : openAnimations(start, rows.filter(({ box }) => box.top >= foldTop - 1), anchorShift, foldTop, frame);
    if (animations.length === 0) return;
    if (overlay.childElementCount > 0) container.parentElement?.append(overlay);
    if (content) content.style.overflow = 'clip';
    const stop = () => {
        for (const animation of animations) animation.cancel();
        overlay.remove();
        if (content) content.style.overflow = '';
    };
    runningMotions.set(container, stop);
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        if (runningMotions.get(container) === stop) stopFoldMotion(container);
    });
};
