/**
 * Overlay rectangles for a captured text selection.
 *
 * While a comment input owns focus the native selection is gone, so the
 * quoted fragment is repainted with these rects (styled by
 * `.oc-chat-comment-rect`). Raw Range.getClientRects() mixes block-container
 * boxes with text boxes and the translucent overlaps paint double-dark bands,
 * so rects are taken from the text nodes only and merged into one strip per
 * visual line, each stretched to its element's line-height the way the native
 * selection paints a line box.
 */
export const collectSelectionOverlayRects = (range: Range): DOMRect[] => {
    const textRects: DOMRect[] = [];
    const pushNodeRects = (node: Text) => {
        const nodeRange = document.createRange();
        nodeRange.selectNodeContents(node);
        if (node === range.startContainer) nodeRange.setStart(node, range.startOffset);
        if (node === range.endContainer) nodeRange.setEnd(node, range.endOffset);
        const lineHeight = node.parentElement
            ? Number.parseFloat(window.getComputedStyle(node.parentElement).lineHeight)
            : Number.NaN;
        for (const rect of nodeRange.getClientRects()) {
            if (rect.width <= 0 || rect.height <= 0) continue;
            if (Number.isFinite(lineHeight) && lineHeight > rect.height) {
                const expand = (lineHeight - rect.height) / 2;
                textRects.push(new DOMRect(rect.left, rect.top - expand, rect.width, lineHeight));
            } else {
                textRects.push(rect);
            }
        }
    };
    const root = range.commonAncestorContainer;
    if (root instanceof Text) {
        pushNodeRects(root);
    } else {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node instanceof Text && range.intersectsNode(node)) pushNodeRects(node);
        }
    }

    const lines: Array<{ left: number; right: number; top: number; bottom: number }> = [];
    for (const rect of textRects) {
        const line = lines.find((candidate) => (
            Math.abs(candidate.top - rect.top) < 6 && Math.abs(candidate.bottom - rect.bottom) < 6
        ));
        if (line) {
            line.left = Math.min(line.left, rect.left);
            line.right = Math.max(line.right, rect.right);
            line.top = Math.min(line.top, rect.top);
            line.bottom = Math.max(line.bottom, rect.bottom);
        } else {
            lines.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
        }
    }
    return lines.map((line) => new DOMRect(line.left, line.top, line.right - line.left, line.bottom - line.top));
};
