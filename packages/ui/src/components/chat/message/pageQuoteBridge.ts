
import type { ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';

import type { HtmlRenderMark } from './parts/htmlRender';

export interface PageFrameHandle {
    partId: string;
    reveal: (anchor: ChatQuoteAnchor) => void;
    clearSelection: () => void;
}

const frames = new Set<PageFrameHandle>();

export function registerPageFrame(handle: PageFrameHandle): () => void {
    frames.add(handle);
    return () => { frames.delete(handle); };
}

export function revealPageMark(partId: string, anchor: ChatQuoteAnchor): boolean {
    const handle = [...frames].reverse().find((candidate) => candidate.partId === partId);
    handle?.reveal(anchor);
    return Boolean(handle);
}

export function clearOtherPageSelections(except: PageFrameHandle): void {
    for (const handle of frames) {
        if (handle !== except) handle.clearSelection();
    }
}

export type PageMarksOwner = symbol;

const marksByOwner = new Map<PageMarksOwner, Map<string, HtmlRenderMark[]>>();
const markListeners = new Map<string, Set<() => void>>();

export function setPageMarks(owner: PageMarksOwner, byPart: Map<string, HtmlRenderMark[]>): void {
    const touched = new Set([...(marksByOwner.get(owner)?.keys() ?? []), ...byPart.keys()]);
    if (byPart.size > 0) {
        marksByOwner.set(owner, byPart);
    } else {
        marksByOwner.delete(owner);
    }
    for (const partId of touched) {
        markListeners.get(partId)?.forEach((listener) => listener());
    }
}

export function getPageMarks(partId: string): HtmlRenderMark[] {
    return [...marksByOwner.values()].flatMap((byPart) => byPart.get(partId) ?? []);
}

export function subscribePageMarks(partId: string, listener: () => void): () => void {
    const listeners = markListeners.get(partId) ?? new Set<() => void>();
    listeners.add(listener);
    markListeners.set(partId, listeners);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) markListeners.delete(partId);
    };
}

export interface PageMarkClick {
    partId: string;
    markId: string;
    measure: () => DOMRect;
    portalTarget: HTMLElement | null;
}

const clickListeners = new Set<(click: PageMarkClick) => void>();

export function onPageMarkClick(listener: (click: PageMarkClick) => void): () => void {
    clickListeners.add(listener);
    return () => { clickListeners.delete(listener); };
}

export function emitPageMarkClick(click: PageMarkClick): void {
    clickListeners.forEach((listener) => listener(click));
}
