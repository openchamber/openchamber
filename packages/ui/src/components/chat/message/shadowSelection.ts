/**
 * Chromium and WebKit report a selection made inside a shadow root to the
 * document as an element range over the host's light-DOM container: the text
 * comes through, but the range has no client rects. Anything positioned from
 * that range lands in the top-left corner. The widget that owns the selection
 * (a diff rendered by `@pierre/diffs`, for one) holds the range with real
 * geometry.
 */

import { trimSelectionValue } from './selectionMarkdown';

// `getSelection` on a ShadowRoot is a Chromium/WebKit extension absent from
// the DOM types. Only the members this module reads are named.
interface ShadowSelection {
    readonly isCollapsed: boolean;
    readonly rangeCount: number;
    toString(): string;
    getRangeAt(index: number): Range;
}

type ShadowRootWithSelection = ShadowRoot & { getSelection?: () => ShadowSelection | null };

const selectedRangeInShadowRoot = (host: Element, text: string): Range | null => {
    // SAFETY: Chromium and WebKit expose `getSelection` on a ShadowRoot; the
    // DOM types omit the extension.
    const shadowRoot = host.shadowRoot as ShadowRootWithSelection | null;
    const selection = shadowRoot?.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    // Another selection in the same document must not anchor this one.
    if (trimSelectionValue(selection.toString()) !== text) return null;
    return selection.getRangeAt(0);
};

/**
 * The range the selection really covers when the document range only points at
 * a shadow host, or null for an ordinary selection.
 */
export const resolveShadowSelectionRange = (range: Range, text: string): Range | null => {
    const element = range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    if (!element || !text) return null;

    const boundaries = [
        [range.startContainer, range.startOffset],
        [range.endContainer, range.endOffset],
    ] as const;

    for (const [container, offset] of boundaries) {
        if (container !== element) continue;
        const child = element.childNodes[offset];
        if (!(child instanceof Element)) continue;
        const shadowRange = selectedRangeInShadowRoot(child, text);
        if (shadowRange) return shadowRange;
    }
    return null;
};
