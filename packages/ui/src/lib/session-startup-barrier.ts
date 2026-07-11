/** Coordinates Electron's initial session pass before normal boot work starts. */
let active = false;
let releasePromise: Promise<void> = Promise.resolve();
let releaseCurrent: (() => void) | null = null;

export const beginSessionStartupBarrier = (): void => {
  if (active) return;
  active = true;
  releasePromise = new Promise<void>((resolve) => { releaseCurrent = resolve; });
};

export const waitForSessionStartupBarrier = async (): Promise<void> => releasePromise;

export const releaseSessionStartupBarrier = (): void => {
  if (!active) return;
  active = false;
  const release = releaseCurrent;
  releaseCurrent = null;
  release?.();
};

export const isSessionStartupBarrierActive = (): boolean => active;
