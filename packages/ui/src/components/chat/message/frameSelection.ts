
import type { ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';

const FRAME_SELECTION_EVENT = 'openchamber:frame-selection';

export interface FrameRect {
    top: number;
    left: number;
    width: number;
    height: number;
}

export interface FrameSelection {
    text: string;
    rect: FrameRect;
    anchor?: ChatQuoteAnchor;
    clear?: () => void;
    dismiss?: boolean;
}

export function dispatchFrameSelection(frame: HTMLElement, selection: FrameSelection): void {
    frame.dispatchEvent(new CustomEvent<FrameSelection>(FRAME_SELECTION_EVENT, { bubbles: true, detail: selection }));
}

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

export function frameRectInApp(frame: HTMLElement, rect: FrameRect): DOMRect {
    const frameBox = frame.getBoundingClientRect();
    return new DOMRect(frameBox.left + rect.left, frameBox.top + rect.top, rect.width, rect.height);
}
