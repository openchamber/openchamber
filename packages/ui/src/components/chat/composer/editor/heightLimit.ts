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
        limit = Math.min(limit, Math.max(0, available));
    }
    return limit;
}

export function getComposerHostHeightLimit(
    scrollHeightLimit: number,
    editorHeight: number,
    renderedScrollHeight: number,
): number {
    return scrollHeightLimit + Math.max(0, editorHeight - renderedScrollHeight);
}
