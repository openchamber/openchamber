/**
 * How long a tool row ran. A finished run shows tenths; a running one counts
 * whole seconds on the shared 1 s tick, so a live row redraws once a second, in
 * step with the session list's counter.
 */
export const formatToolDuration = (start: number, end?: number, now: number = Date.now()): string => {
    if (end === undefined) {
        return `${Math.floor(Math.max(0, now - start) / 1000)}s`;
    }
    const seconds = Math.max(0, end - start) / 1000;
    return `${Math.max(0.1, seconds).toFixed(1)}s`;
};

/**
 * How long a subagent run took. A tool call ends in seconds, but a run lasts
 * minutes, and `1784.4s` is a number nobody converts in their head: past a
 * minute it reads `29m 44s`, past an hour `1h 2m`. The count still comes from
 * the same clock, so a running row keeps its 1 s tick.
 */
export const formatRunDuration = (start: number, end?: number, now: number = Date.now()): string => {
    const seconds = Math.max(0, (end ?? now) - start) / 1000;
    if (seconds < 60) return formatToolDuration(start, end, now);
    const whole = Math.floor(seconds);
    const minutes = Math.floor(whole / 60);
    if (minutes < 60) return `${minutes}m ${whole % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
};
