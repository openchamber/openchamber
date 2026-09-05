export interface ComposerHeightLimitOptions {
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

export interface ComposerHostHeightLimitOptions {
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
