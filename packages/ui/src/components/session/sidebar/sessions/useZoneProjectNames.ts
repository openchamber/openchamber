import { useProjectsStore } from '@/stores/useProjectsStore';

/**
 * Whether detailed rows of the zones that mix projects print their project's
 * name after its icon. With one project the name would repeat on every row
 * and tell nothing, so the icon stands alone there.
 */
export const useZoneProjectNames = (): boolean => useProjectsStore((state) => state.projects.length > 1);
