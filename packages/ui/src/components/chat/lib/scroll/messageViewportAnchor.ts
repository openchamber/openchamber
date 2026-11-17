export interface MessageViewportAnchor {
    readonly messageId: string;
    readonly offsetTop: number;
    readonly slice?: string;
}

export type ViewportAnchorAlignment = 'missing' | 'moved' | 'aligned';

export const ANCHOR_HOLD_STABLE_FRAMES = 30;
export const ANCHOR_HOLD_MAX_FRAMES = 180;

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

export const captureMessageViewportAnchor = (container: HTMLElement): MessageViewportAnchor | null => {
    const containerTop = container.getBoundingClientRect().top;
    let best: { node: HTMLElement; top: number } | null = null;
    let fallback: { node: HTMLElement; top: number } | null = null;

    for (const node of container.querySelectorAll<HTMLElement>('[data-message-id]')) {
        const rect = node.getBoundingClientRect();
        if (rect.bottom <= containerTop + 1) continue;
        if (!fallback || rect.top < fallback.top) fallback = { node, top: rect.top };
        if (best && rect.top >= best.top) continue;
        if (rect.top <= containerTop + 1 && isInsideStuckSticky(node, container, containerTop)) continue;
        best = { node, top: rect.top };
    }

    const chosen = best ?? fallback;
    const messageId = chosen?.node.dataset.messageId;
    if (!chosen || !messageId) return null;
    const slice = chosen.node.dataset.messageSlice;
    return slice ? { messageId, offsetTop: chosen.top - containerTop, slice } : { messageId, offsetTop: chosen.top - containerTop };
};
