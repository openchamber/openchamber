import { useProjectsStore } from '@/stores/useProjectsStore';

export const useZoneProjectNames = (): boolean => useProjectsStore((state) => state.projects.length > 1);
