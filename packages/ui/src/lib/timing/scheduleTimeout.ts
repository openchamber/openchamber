export const scheduleTimeout = (run: () => void, delayMs: number): (() => void) => {
  const timer = window.setTimeout(run, delayMs);
  return () => window.clearTimeout(timer);
};
