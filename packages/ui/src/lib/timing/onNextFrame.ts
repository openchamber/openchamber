export const onNextFrame = (run: () => void): (() => void) => {
  const frame = window.requestAnimationFrame(run);
  return () => window.cancelAnimationFrame(frame);
};
