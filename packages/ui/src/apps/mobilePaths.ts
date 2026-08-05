import type { ProjectEntry } from '@/lib/api/types';

export const normalizePath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

export const getProjectLabel = (path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1]?.replace(/[-_]/g, ' ') || normalized;
};

export const getProjectDisplayLabel = (project: ProjectEntry | null, fallbackDirectory: string): string => {
  if (project) return project.label?.trim() || getProjectLabel(project.path);
  return getProjectLabel(fallbackDirectory);
};
