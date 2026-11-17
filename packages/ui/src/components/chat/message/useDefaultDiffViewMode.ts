import { useUIStore } from '@/stores/useUIStore';

import type { DiffViewMode } from './DiffViewToggle';

export const useDefaultDiffViewMode = (): DiffViewMode => (
    useUIStore((state) => state.diffLayoutPreference) === 'side-by-side' ? 'side-by-side' : 'unified'
);
