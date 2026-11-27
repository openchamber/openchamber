export const onEachFrame = (tick: () => boolean): (() => void) => {
  let frame: number | null = null;
  const run = () => {
    frame = tick() ? window.requestAnimationFrame(run) : null;
  };
  frame = window.requestAnimationFrame(run);
  return () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
  };
};
