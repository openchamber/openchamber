import type { EditPermissionMode } from '@/stores/types/sessionTypes';

export interface EditModeColors {
    text: string;
    border?: string;
    background?: string;
    borderWidth?: number;
}

export const getEditModeColors = (mode?: EditPermissionMode | null): EditModeColors | null => {
    if (mode === 'full') {
        return {
            text: 'var(--status-info)',
            border: 'color-mix(in srgb, var(--status-info) 25%, transparent)',
            background: 'color-mix(in srgb, var(--status-info) 4%, transparent)',
            borderWidth: 1.5,
        };
    }

    if (mode === 'allow') {
        return {
            text: 'var(--status-info)',
            border: 'color-mix(in srgb, var(--status-info) 25%, transparent)',
            background: 'color-mix(in srgb, var(--status-info) 4%, transparent)',
            borderWidth: 1.5,
        };
    }

    return null;
};
