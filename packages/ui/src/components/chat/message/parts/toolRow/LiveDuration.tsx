import React from 'react';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';

// A finished run shows tenths; a running one counts whole seconds on the
// shared 1 s tick, so a live row redraws once a second, in step with the
// session list's counter.
const formatDuration = (start: number, end?: number, now: number = Date.now()) => {
    if (end === undefined) {
        return `${Math.floor(Math.max(0, now - start) / 1000)}s`;
    }
    const seconds = Math.max(0, end - start) / 1000;
    return `${Math.max(0.1, seconds).toFixed(1)}s`;
};

export const LiveDuration: React.FC<{ start: number; end?: number; active: boolean }> = ({ start, end, active }) => {
    const now = useDurationTickerNow(active);

    return <>{formatDuration(start, end, now)}</>;
};
