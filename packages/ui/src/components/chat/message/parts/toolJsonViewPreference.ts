import { getSafeStorage } from '@/stores/utils/safeStorage';

const TOOL_JSON_VIEW_MODE_KEY = 'openchamber:tool-json-view-mode';

declare global {
    interface Window {
        __openchamberToolJsonViewStorage?: Storage;
    }
}

export type ToolJsonViewMode = 'summary' | 'formatted' | 'raw';

const readToolJsonViewMode = (value: string | null): ToolJsonViewMode | null => {
    if (value === 'summary' || value === 'formatted' || value === 'raw') {
        return value;
    }
    return null;
};

export const parseToolJsonViewMode = (value: string | null): ToolJsonViewMode => (
    readToolJsonViewMode(value) ?? 'summary'
);

export const resolveToolJsonViewStorage = (
    localStorage: Storage,
    hostWindow: Pick<Window, '__openchamberToolJsonViewStorage'> | null,
): Storage => {
    if (!hostWindow) return localStorage;

    try {
        if (!hostWindow.__openchamberToolJsonViewStorage) {
            hostWindow.__openchamberToolJsonViewStorage = localStorage;
        }
        return hostWindow.__openchamberToolJsonViewStorage;
    } catch {
        return localStorage;
    }
};

const getToolJsonViewStorage = (): Storage => {
    const localStorage = getSafeStorage();
    const currentWindow = globalThis.window;
    if (!currentWindow) return localStorage;

    return resolveToolJsonViewStorage(localStorage, currentWindow.top ?? currentWindow);
};

export const getToolJsonViewMode = (): ToolJsonViewMode => (
    parseToolJsonViewMode(getToolJsonViewStorage().getItem(TOOL_JSON_VIEW_MODE_KEY))
);

export const setToolJsonViewMode = (value: ToolJsonViewMode): void => {
    getToolJsonViewStorage().setItem(TOOL_JSON_VIEW_MODE_KEY, value);
};
