import type { UpdateProgress } from '@/lib/desktop';

// external: #5759 Differential download transferred bytes can exceed total; cap the displayed percentage at 100.
export const updateProgressPercent = (progress: UpdateProgress | null | undefined): number => {
  if (!progress?.total) return 0;
  const percent = Math.round((progress.downloaded / progress.total) * 100);
  return Math.min(100, Math.max(0, percent));
};
