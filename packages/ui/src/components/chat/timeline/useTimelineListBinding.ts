import React from 'react';
import type { LegendListRef } from '@legendapp/list/react';

import { useStableEvent } from './useStableEvent';
import type { ListMetrics } from './types';

/**
 * The list ref and the callbacks that reach the list. Their identities are
 * stable: a changing callback would re-render every mounted row.
 */
export const useTimelineListBinding = ({
    registerList,
    onIsAtEndChange,
    onTimelineDataChange,
    onListMetricsChange,
}: {
    registerList?: (list: LegendListRef | null) => void;
    onIsAtEndChange?: (isAtEnd: boolean) => void;
    onTimelineDataChange?: () => void;
    onListMetricsChange?: (metrics: ListMetrics) => void;
}) => {
    // Every surface uses the same virtualized list for the whole timeline —
    // there is no small-list DOM path to transition out of, which is what used
    // to remount the history subtree mid-prepend.
    const listRef = React.useRef<LegendListRef | null>(null);
    const handleRegisterList = React.useCallback((list: LegendListRef | null) => {
        listRef.current = list;
        registerList?.(list);
    }, [registerList]);

    const stableIsAtEndChange = useStableEvent((isAtEnd: boolean) => {
        if (listRef.current) onIsAtEndChange?.(isAtEnd);
    });

    const stableTimelineDataChange = useStableEvent(() => {
        if (listRef.current) onTimelineDataChange?.();
    });

    const stableListMetricsChange = useStableEvent((metrics: ListMetrics) => {
        if (listRef.current) onListMetricsChange?.(metrics);
    });

    return {
        listRef,
        handleRegisterList,
        stableIsAtEndChange,
        stableTimelineDataChange,
        stableListMetricsChange,
    };
};
