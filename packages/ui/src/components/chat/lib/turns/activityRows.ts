import { createContext } from 'react';

import type { Part, ToolPart } from '@/lib/opencode/model';
import { filterVisibleParts, isEmptyTextPart } from '../../message/partUtils';


export const LIVE_ACTIVITY_VISIBLE_ROWS = 7;

const isToolRunning = (status: string | undefined): boolean => (
    status === 'pending' || status === 'running' || status === 'started'
);

export const isToolRowShown = (toolPart: ToolPart): boolean => {
    const { state } = toolPart;
    if (isToolRunning(state.status)) return true;
    if (state.status !== 'completed' && state.status !== 'error') return false;
    return state.time.end >= state.time.start;
};

export const isActivityRowPart = (part: Part): boolean => {
    if (part.type === 'tool') return isToolRowShown(part);
    if (part.type === 'text') return !isEmptyTextPart(part);
    return part.type === 'reasoning';
};

export const activityRowParts = (parts: Part[], showReasoning: boolean): Part[] => (
    filterVisibleParts(parts, { includeReasoning: showReasoning }).filter(isActivityRowPart)
);

interface ActivityTrim {
    readonly hiddenMessages: number;
    readonly skipRows: number;
    readonly hiddenRows: number;
}

const NO_TRIM: ActivityTrim = { hiddenMessages: 0, skipRows: 0, hiddenRows: 0 };

export const planActivityTrim = (rowsPerMessage: readonly number[], visibleRows: number): ActivityTrim => {
    let kept = 0;
    for (let index = rowsPerMessage.length - 1; index >= 0; index -= 1) {
        const rows = rowsPerMessage[index] ?? 0;
        if (kept + rows <= visibleRows) {
            kept += rows;
            continue;
        }
        let hiddenRows = 0;
        for (let earlier = 0; earlier <= index; earlier += 1) hiddenRows += rowsPerMessage[earlier] ?? 0;
        const skipRows = rows - (visibleRows - kept);
        if (skipRows >= rows) return { hiddenMessages: index + 1, skipRows: 0, hiddenRows };
        return { hiddenMessages: index, skipRows, hiddenRows: hiddenRows - (rows - skipRows) };
    }
    return NO_TRIM;
};

export const ActivityRowSkipContext = createContext<{ messageId: string; rows: number } | null>(null);
