export const afterDelay = (ms: number, run: () => void): (() => void) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};
