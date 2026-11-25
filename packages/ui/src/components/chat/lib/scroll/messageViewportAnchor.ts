export interface MessageViewportAnchor {
    readonly messageId: string;
    readonly offsetTop: number;
    readonly slice?: string;
    readonly kept?: { readonly row: string; readonly partId: string };
}

export type ViewportAnchorAlignment = 'missing' | 'moved' | 'aligned';

export const ANCHOR_HOLD_STABLE_FRAMES = 30;
export const ANCHOR_HOLD_MAX_FRAMES = 180;
const MESSAGE_LINK_GAP_PX = 12;

export const messageLinkOffsetTop = (node: HTMLElement): number => {
    const fade = Number.parseFloat(getComputedStyle(node).getPropertyValue('--scroll-shadow-size'));
    return (Number.isFinite(fade) ? fade : 0) + MESSAGE_LINK_GAP_PX;
};

const isInsideStuckSticky = (node: HTMLElement, container: HTMLElement, containerTop: number): boolean => {
    const view = node.ownerDocument.defaultView;
    if (!view) return false;

    let current: HTMLElement | null = node;
    while (current && current !== container) {
        const computed = view.getComputedStyle(current);
        if (computed.position === 'sticky' && current.getBoundingClientRect().top <= containerTop + 1) {
            return true;
        }
        current = current.parentElement;
    }

    return false;
};

type Candidate = { node: HTMLElement; top: number };

type TopmostCandidates = { best: Candidate | null; fallback: Candidate | null };

const pickTopmost = (nodes: Iterable<HTMLElement>, container: HTMLElement, containerTop: number): TopmostCandidates => {
    let best: Candidate | null = null;
    let fallback: Candidate | null = null;

    for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.bottom <= containerTop + 1) continue;
        if (!fallback || rect.top < fallback.top) fallback = { node, top: rect.top };
        if (best && rect.top >= best.top) continue;
        if (rect.top <= containerTop + 1 && isInsideStuckSticky(node, container, containerTop)) continue;
        best = { node, top: rect.top };
    }

    return { best, fallback };
};

const messageAnchor = (chosen: Candidate, containerTop: number): MessageViewportAnchor | null => {
    const messageId = chosen.node.dataset.messageId;
    if (!messageId) return null;
    const offsetTop = chosen.top - containerTop;
    const slice = chosen.node.dataset.messageSlice;
    return slice ? { messageId, offsetTop, slice } : { messageId, offsetTop };
};

const keptAnchor = (chosen: Candidate, containerTop: number): MessageViewportAnchor | null => {
    const messageId = chosen.node.dataset.messageId;
    const partId = chosen.node.dataset.messageHoisted;
    const row = chosen.node.closest<HTMLElement>('[data-row-key]')?.dataset.rowKey;
    if (!messageId || !partId || !row) return null;
    return { messageId, offsetTop: chosen.top - containerTop, kept: { row, partId } };
};

export const captureMessageViewportAnchor = (container: HTMLElement): MessageViewportAnchor | null => {
    const { top: containerTop, bottom: containerBottom } = container.getBoundingClientRect();
    const message = pickTopmost(container.querySelectorAll<HTMLElement>('[data-message-id]:not([data-message-hoisted])'), container, containerTop);
    if (message.best && message.best.top < containerBottom) return messageAnchor(message.best, containerTop);

    const kept = pickTopmost(container.querySelectorAll<HTMLElement>('[data-row-key] [data-message-id][data-message-hoisted]'), container, containerTop);
    const visibleKept = kept.best && kept.best.top < containerBottom ? kept.best : null;
    if (visibleKept) return keptAnchor(visibleKept, containerTop);

    const chosen = message.best ?? message.fallback;
    return chosen ? messageAnchor(chosen, containerTop) : null;
};
