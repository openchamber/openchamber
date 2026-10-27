import type { UpdateProgress } from '@/lib/desktop';

/**
 * Desktop download percentage for the update dialog, clamped to 0-100.
 * In a differential download electron-updater's `total` counts only the
 * changed blocks fetched over the network, and the transferred count can run
 * far past it (#5759 showed 1568%), so the raw ratio is capped the same way
 * the Windows taskbar progress is.
 */
export const updateProgressPercent = (progress: UpdateProgress | null | undefined): number => {
  if (!progress?.total) return 0;
  const percent = Math.round((progress.downloaded / progress.total) * 100);
  return Math.min(100, Math.max(0, percent));
};
