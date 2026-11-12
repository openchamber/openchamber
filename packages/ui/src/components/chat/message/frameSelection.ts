/**
 * A selection made inside a sandboxed page frame (`openchamber_render`). The
 * app cannot read it, so the frame reports it and the selection menu of the
 * page picks it up (`frameSelections` on TextSelectionMenu). It travels as a
 * DOM event from the frame element, so only the menu whose container holds
 * that frame hears it.
 */

import type { ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';

const FRAME_SELECTION_EVENT = 'openchamber:frame-selection';

export interface FrameRect {
    top: number;
    left: number;
    width: number;
    height: number;
}

export interface FrameSelection {
    /** Empty when the selection is gone. */
    text: string;
    /** The selection's box in the frame's own viewport. */
    rect: FrameRect;
    /** The selection as a quote anchor in the page's own text; set by the frame's owner. */
    anchor?: ChatQuoteAnchor;
    /**
     * Drops the selection in the page and tells the menu it is gone. The menu
     * calls it whenever it stops tracking this selection, so the page does not
     * keep a highlight the menu no longer answers to.
     */
    clear?: () => void;
    /** On an empty selection: close the menu even while a comment is open (another page took over). */
    dismiss?: boolean;
}

export function dispatchFrameSelection(frame: HTMLElement, selection: FrameSelection): void {
    frame.dispatchEvent(new CustomEvent<FrameSelection>(FRAME_SELECTION_EVENT, { bubbles: true, detail: selection }));
}

/** Listens for frame selections inside `container`; the listener gets the frame that reported. */
export function onFrameSelection(
    container: HTMLElement,
    listener: (selection: FrameSelection, frame: HTMLElement) => void,
): () => void {
    const handle = (event: Event) => {
        if (event instanceof CustomEvent && event.target instanceof HTMLElement) {
            listener(event.detail, event.target);
        }
    };
    container.addEventListener(FRAME_SELECTION_EVENT, handle);
    return () => container.removeEventListener(FRAME_SELECTION_EVENT, handle);
}

/** A box in the frame's own viewport, in app viewport coordinates from the frame's current position. */
export function frameRectInApp(frame: HTMLElement, rect: FrameRect): DOMRect {
    const frameBox = frame.getBoundingClientRect();
    return new DOMRect(frameBox.left + rect.left, frameBox.top + rect.top, rect.width, rect.height);
}
