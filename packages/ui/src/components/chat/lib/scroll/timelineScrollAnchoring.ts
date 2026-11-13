// Scroll geometry for the chat timeline.
//
// The timeline has two mutually exclusive scroll modes:
//
//   • `following-end`  — stay pinned to the live edge as content grows.
//   • `free-scrolling` — the user took over; nothing moves the scroll
//     position until they opt back in.
//
// This module is pure geometry: it reads measurements from the virtualized
// list and answers where the real content ends and whether the viewport is
// there. Keeping it free of DOM and React makes the rules testable without a
// renderer.

export type TimelineScrollMode = 'following-end' | 'free-scrolling';

export interface TimelineListMeasurementState {
    readonly data: readonly unknown[];
    readonly scroll: number;
    readonly scrollLength: number;
    readonly positionAtIndex: (index: number) => number | undefined;
    readonly sizeAtIndex: (index: number) => number | undefined;
}

export const getRowBottom = (
    state: TimelineListMeasurementState,
    index: number,
): number | null => {
    const top = state.positionAtIndex(index);
    const height = state.sizeAtIndex(index);
    if (
        top === undefined
        || height === undefined
        || !Number.isFinite(top)
        || !Number.isFinite(height)
    ) {
        return null;
    }
    // Rows measured at zero height would read as no content at all; treat
    // them as one pixel tall instead.
    return top + Math.max(1, height);
};

// The scroll offset of the real content's end: the same place as the scroll
// node's own end (`scrollHeight - clientHeight`) once the list is measured,
// taken from the rows because that total lags a re-wrap. Row positions start
// below the list header, and the footer (question and permission cards,
// error notices, the tail spacer the composer and the status row float over)
// renders after the last row; the list does not expose either size through
// getState, so the caller passes the last reported values. Leaving the
// header out and counting the status row's reserve again on top of the
// footer, the end came out 8 px short of the scroll node's in a typical
// session, and a resize settling moved a reader on the end by that much.
export const resolveRealContentEndOffset = ({
    state,
    headerSize = 0,
    footerSize = 0,
}: {
    readonly state: TimelineListMeasurementState;
    readonly headerSize?: number;
    readonly footerSize?: number;
}): number | null => {
    const lastIndex = state.data.length - 1;
    if (lastIndex < 0) return null;
    const lastBottom = getRowBottom(state, lastIndex);
    if (lastBottom === null) return null;
    return Math.max(0, Math.max(0, headerSize) + lastBottom + Math.max(0, footerSize) - state.scrollLength);
};

// Keep return-to-end detection in a tight band, rather than half a viewport.
export const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export const resolveTimelineIsAtEnd = (
    state: {
        readonly contentLength?: number;
        readonly scroll?: number;
        readonly scrollLength?: number;
        readonly isNearEnd?: boolean;
        readonly isAtEnd?: boolean;
    } | undefined,
): boolean | undefined => {
    if (!state) return undefined;
    const { contentLength, scroll, scrollLength } = state;
    if (
        contentLength !== undefined
        && scroll !== undefined
        && scrollLength !== undefined
        && Number.isFinite(contentLength)
    ) {
        return contentLength - (scroll + scrollLength) <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
    }
    return state.isNearEnd ?? state.isAtEnd;
};
