import React from 'react';

export function useStackedLiveRows(): [ReadonlySet<string>, (path: string, live: boolean) => void] {
    const [liveRows, setLiveRows] = React.useState<ReadonlySet<string>>(() => new Set());
    const onLiveChange = React.useCallback((path: string, live: boolean) => {
        setLiveRows((previous) => {
            if (live === previous.has(path)) return previous;
            const next = new Set(previous);
            if (live) next.add(path);
            else next.delete(path);
            return next;
        });
    }, []);
    return [liveRows, onLiveChange];
}

export function useLiveRowReport(path: string, live: boolean, report: ((path: string, live: boolean) => void) | undefined) {
    React.useEffect(() => {
        if (!live || !report) return undefined;
        report(path, true);
        return () => report(path, false);
    }, [live, path, report]);
}
