
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
    return top + Math.max(1, height);
};

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
