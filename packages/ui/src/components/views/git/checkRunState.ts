import React from 'react';

export const formatElapsedDuration = (startISO?: string, endISO?: string, now?: number): string | null => {
  if (!startISO) return null;
  const start = Date.parse(startISO);
  if (!Number.isFinite(start)) return null;
  const end = endISO ? Date.parse(endISO) : (now ?? Date.now());
  if (!Number.isFinite(end) || end <= start) return null;
  const totalMinutes = Math.floor((end - start) / 60_000);
  if (totalMinutes < 1) return '<1m';
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
};

export const isFailedConclusion = (conclusion?: string | null): boolean => {
  const normalized = conclusion ? conclusion.toLowerCase() : '';
  return Boolean(normalized) && !['success', 'neutral', 'skipped'].includes(normalized);
};

const toggled = (previous: Set<string>, key: string): Set<string> => {
  const next = new Set(previous);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

/** Which runs and failed steps are open; kept by whoever shows the list, so it outlives the list itself. */
export const useCheckRunExpansion = () => {
  const [runs, setRuns] = React.useState<Set<string>>(() => new Set());
  const [steps, setSteps] = React.useState<Set<string>>(() => new Set());
  const toggleRun = React.useCallback((key: string) => setRuns((previous) => toggled(previous, key)), []);
  const toggleStep = React.useCallback((key: string) => setSteps((previous) => toggled(previous, key)), []);
  return { runs, steps, toggleRun, toggleStep };
};

export type CheckRunExpansion = ReturnType<typeof useCheckRunExpansion>;
