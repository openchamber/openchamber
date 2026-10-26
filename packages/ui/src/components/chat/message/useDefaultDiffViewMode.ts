import { useUIStore } from '@/stores/useUIStore';

import type { DiffViewMode } from './DiffViewToggle';

/**
 * The layout a diff preview in chat opens with: the diff layout setting.
 * Dynamic counts as unified here, as in the walkthrough: a preview sits in a
 * column too narrow to split.
 */
export const useDefaultDiffViewMode = (): DiffViewMode => (
    useUIStore((state) => state.diffLayoutPreference) === 'side-by-side' ? 'side-by-side' : 'unified'
);
