// Pure frame-layout model for the conversation-seam resize controller.
//
// DOM-free. The controller keeps a per-frame layout of the MOUNTED rows (real
// DOM heights only — TanStack's cache is a commit target, never a change
// source) plus the anchor's DOCUMENT top (flowStartRect.top -
// scrollerRect.top + scrollTop). Every width frame compares the new layout to
// the PREVIOUS committed frame:
//
//   anchorDelta = next.anchorDocumentTop - previous.anchorDocumentTop
//   target      = currentScrollTop + anchorDelta
//
// Because the delta is relative to the last committed frame (never to a
// capture-time baseline), a +10 growth writes +10 once; the next frame with
// no growth has delta strictly 0 (zero writes); a further +5 writes +5. The
// anchor row's own growth or any growth AFTER it leaves its document top
// unchanged -> delta 0. Clamping at the scroll bounds keeps the transaction
// ACTIVE (state 'clamped'), preserving the anchor key/baseline/held range so
// a reverse drag resumes automatically — it is NOT a release.

export interface MountedRowInfo {
    key: string;
    virtualIndex: number | null;
    height: number;
}

export interface ResizeFrameLayout {
    anchorKey: string;
    /** Document top of the anchor's flow start (css px). */
    anchorDocumentTop: number;
    /** Real mounted rows of THIS frame (key -> info). */
    mountedRows: Map<string, MountedRowInfo>;
    mountedStart: number | null;
    mountedEnd: number | null;
}

export interface ResizeLayoutTransaction {
    transactionId: number;
    anchorKey: string;
    anchorVirtualIndex: number | null;
    /** Anchor viewport top captured at drag start (diagnostics). */
    capturedViewportTop: number;
    /** Layout of the last COMMITTED frame (updated after every write). */
    previousLayout: ResizeFrameLayout;
    /** Last processed frame sequence (dedup — never dedupe by width). */
    lastFrameSequence?: number;
    state: 'active' | 'clamped';
}

export const EMPTY_FRAME_LAYOUT = (anchorKey: string): ResizeFrameLayout => ({
    anchorKey,
    anchorDocumentTop: 0,
    mountedRows: new Map(),
    mountedStart: null,
    mountedEnd: null,
});

/** Delta of the anchor's document top between two consecutive committed
 *  frames. Zero when the real heights above the anchor did not change. */
export const computeAnchorDelta = (
    next: ResizeFrameLayout,
    previous: ResizeFrameLayout,
): number => next.anchorDocumentTop - previous.anchorDocumentTop;

/** Target based on the CURRENT scrollTop and the PREVIOUS-frame delta. */
export const computeTargetScrollTop = (currentScrollTop: number, anchorDelta: number): number => (
    currentScrollTop + anchorDelta
);

/** Clamp a target into the legal range; returns the clamped value and whether
 *  the clamp actually engaged (-> transaction state 'clamped'). */
export const clampScrollTarget = (
    target: number,
    scrollHeight: number,
    clientHeight: number,
): { target: number; clamped: boolean } => {
    const max = Math.max(0, scrollHeight - clientHeight);
    const clampedTarget = Math.min(max, Math.max(0, target));
    return { target: clampedTarget, clamped: clampedTarget !== target };
};

/** Real-height comparison between two consecutive frames (> 0.5px). Keys
 *  present in both frames with the same height are NOT changed. */
export const diffMountedRows = (
    previous: ResizeFrameLayout,
    next: ResizeFrameLayout,
    tolerance = 0.5,
): string[] => {
    const changed: string[] = [];
    for (const [key, info] of next.mountedRows) {
        const prev = previous.mountedRows.get(key);
        if (prev === undefined || Math.abs(prev.height - info.height) > tolerance) {
            changed.push(key);
        }
    }
    return changed;
};

/** Initial held range = union of the current mounted indexes and the anchor
 *  window (anchorIndex-1 .. anchorIndex+1). Always covers the previous
 *  assistant row and the anchor row. */
export const initHeldRange = (
    mountedIndexes: readonly number[],
    anchorIndex: number | null,
): { start: number; end: number } => {
    let start = anchorIndex === null ? 0 : Math.max(0, anchorIndex - 1);
    let end = anchorIndex === null ? 0 : anchorIndex + 1;
    for (const index of mountedIndexes) {
        start = Math.min(start, index);
        end = Math.max(end, index);
    }
    return { start, end };
};

/** Monotonic extension: next.start <= previous.start AND next.end >=
 *  previous.end, clamped to [0, count-1]. */
export const extendHeldRange = (
    held: { start: number; end: number },
    normalStart: number,
    normalEnd: number,
    count: number,
): { start: number; end: number } => ({
    start: Math.max(0, Math.min(held.start, normalStart)),
    end: Math.min(count - 1, Math.max(held.end, normalEnd)),
});
