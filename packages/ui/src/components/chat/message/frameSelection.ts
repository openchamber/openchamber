/**
 * A selection made inside a sandboxed page frame (`openchamber_render`). The
 * app cannot read it, so the frame reports it and the message's
 * TextSelectionMenu picks it up. It travels as a DOM event from the frame
 * element, so only the menu whose message holds that frame hears it.
 */

const FRAME_SELECTION_EVENT = 'openchamber:frame-selection';

export interface FrameSelection {
    /** Empty when the selection is gone. */
    text: string;
    /** The selection's box in the frame's own viewport. */
    rect: { top: number; left: number; width: number; height: number };
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

/** The selection's box in app viewport coordinates, from the frame's current position. */
export function frameSelectionRect(frame: HTMLElement, selection: FrameSelection): DOMRect {
    const frameBox = frame.getBoundingClientRect();
    const { top, left, width, height } = selection.rect;
    return new DOMRect(frameBox.left + left, frameBox.top + top, width, height);
}
