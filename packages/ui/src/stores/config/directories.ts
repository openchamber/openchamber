import { opencodeClient } from '@/lib/opencode/client';
import { normalizePath } from '@/lib/pathNormalization';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

export const DIRECTORY_KEY_GLOBAL = "__global__";

export const toDirectoryKey = (directory: string | null | undefined): string => {
    const trimmed = typeof directory === 'string' ? directory.trim() : '';
    return trimmed.length > 0 ? trimmed : DIRECTORY_KEY_GLOBAL;
};

export const fromDirectoryKey = (key: string): string | null => (key === DIRECTORY_KEY_GLOBAL ? null : key);

export const resolveInitialDirectoryKey = (): string => {
    if (typeof window === 'undefined') {
        return DIRECTORY_KEY_GLOBAL;
    }

    const directory = opencodeClient.getDirectory() ?? useDirectoryStore.getState().currentDirectory;
    return toConfigDirectoryKey(directory);
};

export const normalizeConfigPath = (value: string | null | undefined): string | null => {
    const result = normalizePath(value);
    if (result === null) return null;
    return result || '/';
};

const resolveConfigDirectory = normalizeConfigPath;

export const toConfigDirectoryKey = (directory: string | null | undefined): string =>
    toDirectoryKey(resolveConfigDirectory(directory));
