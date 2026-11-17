// external: https://developer.mozilla.org/en-US/docs/Web/API/Selection/getRangeAt Shadow selections can expose host ranges; use the widget range for geometry.

import { trimSelectionValue } from './selectionMarkdown';

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
    if (trimSelectionValue(selection.toString()) !== text) return null;
    return selection.getRangeAt(0);
};

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
