import React from 'react';
import type { LegendListRef } from '@legendapp/list/react';

import { useStableEvent } from './useStableEvent';
import type { ListMetrics } from './types';

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
