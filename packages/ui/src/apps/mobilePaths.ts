import { normalizePath as normalizePathImpl } from '@/lib/pathNormalization';

export const normalizePath = (value?: string | null): string => normalizePathImpl(value) ?? '';

export const getProjectLabel = (path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1]?.replace(/[-_]/g, ' ') || normalized;
};
