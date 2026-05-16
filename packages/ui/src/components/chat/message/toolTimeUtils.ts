export type ActivityPart = {
    kind: string;
    part: {
        state?: {
            time?: {
                start?: number;
                end?: number;
            };
        };
    };
};

export function mergeClippedIntervals(
    intervals: Array<[number, number]>,
): Array<[number, number]> {
    if (intervals.length === 0) return [];
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [[sorted[0][0], sorted[0][1]]];
    for (let i = 1; i < sorted.length; i++) {
        const last = merged[merged.length - 1];
        if (sorted[i][0] <= last[1]) {
            last[1] = Math.max(last[1], sorted[i][1]);
        } else {
            merged.push([sorted[i][0], sorted[i][1]]);
        }
    }
    return merged;
}

export function sumMergedDuration(merged: Array<[number, number]>): number {
    return merged.reduce((sum, iv) => sum + (iv[1] - iv[0]), 0);
}

export function computeMergedToolDurationMs(
    activityParts: ActivityPart[] | undefined,
    windowStart: number,
    windowEnd: number,
): number | undefined {
    if (!activityParts) return undefined;
    const intervals: Array<[number, number]> = [];
    for (const ap of activityParts) {
        if (ap.kind !== 'tool') continue;
        const t = ap.part.state?.time;
        if (t && typeof t.start === 'number' && typeof t.end === 'number' && t.end > t.start) {
            const clippedStart = Math.max(t.start, windowStart);
            const clippedEnd = Math.min(t.end, windowEnd);
            if (clippedEnd > clippedStart) {
                intervals.push([clippedStart, clippedEnd]);
            }
        }
    }
    if (intervals.length === 0) return 0;
    return sumMergedDuration(mergeClippedIntervals(intervals));
}

export function computeToolTimeBeforeTextMs(
    activityParts: ActivityPart[] | undefined,
    messageCreatedAt: number,
    firstTextStart: number | undefined,
): number | undefined {
    if (!activityParts) return undefined;
    if (typeof firstTextStart !== 'number') return 0;
    const windowStart = messageCreatedAt;
    const windowEnd = firstTextStart;
    if (windowEnd <= windowStart) return 0;
    const intervals: Array<[number, number]> = [];
    for (const ap of activityParts) {
        if (ap.kind !== 'tool') continue;
        const t = ap.part.state?.time;
        if (t && typeof t.start === 'number' && typeof t.end === 'number' && t.end > t.start) {
            const clippedStart = Math.max(t.start, windowStart);
            const clippedEnd = Math.min(t.end, windowEnd);
            if (clippedEnd > clippedStart) {
                intervals.push([clippedStart, clippedEnd]);
            }
        }
    }
    if (intervals.length === 0) return 0;
    return sumMergedDuration(mergeClippedIntervals(intervals));
}
