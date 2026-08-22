import { getSafeStorage } from '@/stores/utils/safeStorage';

const TOOL_JSON_VIEW_MODE_KEY = 'openchamber:tool-json-view-mode';

export type ToolJsonViewMode = 'summary' | 'formatted' | 'raw';

export const parseToolJsonViewMode = (value: string | null): ToolJsonViewMode => {
    if (value === 'formatted' || value === 'raw') {
        return value;
    }
    return 'summary';
};

export const getToolJsonViewMode = (): ToolJsonViewMode => (
    parseToolJsonViewMode(getSafeStorage().getItem(TOOL_JSON_VIEW_MODE_KEY))
);

export const setToolJsonViewMode = (value: ToolJsonViewMode): void => {
    getSafeStorage().setItem(TOOL_JSON_VIEW_MODE_KEY, value);
};
