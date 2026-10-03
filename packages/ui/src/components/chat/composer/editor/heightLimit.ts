interface ComposerHeightLimitOptions {
    maxLinesHeight: number;
    boundHeight?: number;
    surroundingHeight?: number;
    boundGapPx?: number;
}

export function getComposerHeightLimit(options: ComposerHeightLimitOptions): number {
    const {
        maxLinesHeight,
        boundHeight,
        surroundingHeight,
        boundGapPx = 0,
    } = options;
    let limit = maxLinesHeight;
    if (boundHeight !== undefined && surroundingHeight !== undefined) {
        const available = boundHeight - surroundingHeight - boundGapPx;
        if (available > 0) limit = Math.min(limit, available);
    }
    return limit;
}

/**
 * Whether the text really outgrew the height cap, so the scroller should
 * offer a vertical scrollbar. Content that fits can still report a pixel or
 * two of overflow (drawn caret, font metrics, rounding), which classic
 * scrollbars on Linux and Windows paint as a useless sliver next to the send
 * button. Real overflow at the cap is at least half a line, so anything
 * smaller is treated as fitting.
 */
export function isComposerContentCapped(contentHeight: number, cap: number, lineHeight: number): boolean {
    return contentHeight - cap > lineHeight / 2;
}

interface ComposerHostHeightLimitOptions {
    maxLinesHeight: number;
    editorHeight: number;
    renderedScrollHeight: number;
    boundHeight?: number;
    branchHeight?: number;
    hostHeight?: number;
    boundGapPx?: number;
}

export function getComposerHostHeightLimit(options: ComposerHostHeightLimitOptions): number {
    const {
        maxLinesHeight,
        editorHeight,
        renderedScrollHeight,
        boundHeight,
        branchHeight,
        hostHeight,
        boundGapPx,
    } = options;
    const editorChrome = Math.max(0, editorHeight - renderedScrollHeight);
    const surroundingHeight = branchHeight !== undefined && hostHeight !== undefined
        ? Math.max(0, branchHeight - hostHeight)
        : undefined;
    return getComposerHeightLimit({
        maxLinesHeight: maxLinesHeight + editorChrome,
        boundHeight,
        surroundingHeight,
        boundGapPx,
    });
}
