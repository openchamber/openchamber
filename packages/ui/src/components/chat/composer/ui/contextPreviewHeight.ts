/** Leave the preview's existing gap above the chip and space below the chat header. */
export const getContextPreviewMaxHeight = (anchorTop: number, boundaryTop: number, viewportHeight: number): number =>
    Math.max(0, Math.min(viewportHeight / 2, 420, anchorTop - Math.max(0, boundaryTop) - 14));
