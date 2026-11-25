const DURATION_MS = 220;
const SAMPLES = 14;
const MAX_TRAVEL_PX = 2400;

const ease = (progress: number): number => 1 - (1 - progress) ** 3;

type Box = { top: number; height: number };

export interface FoldMotionStart {
    anchorKey: string;
    boxes: ReadonlyMap<string, Box>;
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
    return boxes.has(anchorKey) ? { anchorKey, boxes, ghosts } : null;
};

const sampled = (frameAt: (progress: number) => Keyframe): Keyframe[] => (
    Array.from({ length: SAMPLES + 1 }, (_, index) => frameAt(ease(index / SAMPLES)))
);

const FOOTER_KEY = 'footer';

const carrierOf = (element: HTMLElement): HTMLElement => (
    element.dataset.listRow === FOOTER_KEY ? element : element.parentElement ?? element
);

const play = (element: HTMLElement, frameAt: (progress: number) => Keyframe): Animation => (
    carrierOf(element).animate(sampled(frameAt), { duration: DURATION_MS, easing: 'linear' })
);

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

export const playFoldMotion = (container: HTMLElement, start: FoldMotionStart): void => {
    const frame = boxOf(container);
    const elements = new Map<string, HTMLElement>();
    for (const element of rowElements(container)) if (element.dataset.listRow) elements.set(element.dataset.listRow, element);
    const anchor = elements.get(start.anchorKey);
    if (!anchor) return;
    const anchorBox = boxOf(anchor);
    const foldTop = anchorBox.top + anchorBox.height;
    const anchorShift = anchorBox.top - (start.boxes.get(start.anchorKey)?.top ?? anchorBox.top);

    const after = [...elements].map(([key, element]) => ({ key, element, box: boxOf(element) })).filter(({ box }) => box.top >= foldTop - 1).sort((left, right) => left.box.top - right.box.top);
    const opened = after.filter(({ key }) => !start.boxes.has(key));
    const moved = after.filter(({ key }) => start.boxes.has(key));
    const firstMoved = moved[0];
    const firstBefore = firstMoved ? start.boxes.get(firstMoved.key) : undefined;
    const openedHeight = opened.reduce((bottom, { box }) => Math.max(bottom, box.top + box.height), foldTop) - foldTop;
    const travel = firstMoved && firstBefore ? firstMoved.box.top - firstBefore.top - anchorShift : openedHeight;
    const distance = Math.max(-MAX_TRAVEL_PX, Math.min(MAX_TRAVEL_PX, travel));
    if (Math.abs(distance) < 1) return;

    const animations: Animation[] = [];
    const overlay = document.createElement('div');
    const content = container.querySelector<HTMLElement>('.legend-list-content-container');
    const stop = () => {
        for (const animation of animations) animation.cancel();
        overlay.remove();
        if (content) content.style.overflow = '';
    };
    stopFoldMotion(container);
    runningMotions.set(container, stop);
    if (content) content.style.overflow = 'clip';

    for (const { element, box, key } of moved) {
        const before = start.boxes.get(key);
        if (!before || !(onScreen(box, frame) || onScreen(before, frame))) continue;
        animations.push(play(element, (progress) => ({ transform: `translateY(${-distance * (1 - progress)}px)` })));
    }
    if (distance > 0) {
        for (const { element, box } of opened) {
            if (onScreen(box, frame)) animations.push(play(element, (progress) => ({ clipPath: clipBelow(box, foldTop + distance * progress) })));
        }
    }
    const host = container.parentElement;
    if (distance < 0 && host && start.ghosts.size > 0) {
        overlay.inert = true;
        overlay.setAttribute('aria-hidden', 'true');
        Object.assign(overlay.style, {
            position: 'absolute', overflow: 'hidden', pointerEvents: 'none',
            top: `${container.offsetTop}px`, left: `${container.offsetLeft}px`, width: `${container.clientWidth}px`, height: `${container.clientHeight}px`,
        });
        host.append(overlay);
    }
    for (const [key, ghost] of start.ghosts) {
        const before = start.boxes.get(key);
        if (elements.has(key) || !before || !overlay.isConnected) continue;
        stripIdentity(ghost);
        Object.assign(ghost.style, { position: 'absolute', insetInline: '0', top: `${before.top + anchorShift - frame.top}px`, height: `${before.height}px`, overflow: 'hidden', pointerEvents: 'none' });
        overlay.append(ghost);
        const box = { top: before.top + anchorShift, height: before.height };
        animations.push(ghost.animate(sampled((progress) => ({ clipPath: clipBelow(box, foldTop - distance * (1 - progress)) })), { duration: DURATION_MS, easing: 'linear' }));
    }
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        if (runningMotions.get(container) === stop) stopFoldMotion(container);
    });
};
