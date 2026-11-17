import React from 'react';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';

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
