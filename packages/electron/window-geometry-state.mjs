export const createWindowGeometryState = ({
  persist,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  delayMs = 300,
}) => {
  const revisions = new Map();
  const timers = new Map();

  const cancel = (browserWindow) => {
    if (!browserWindow) return;
    const key = String(browserWindow.id);
    const timer = timers.get(key);
    if (timer !== undefined) clearTimeoutFn(timer);
    timers.delete(key);
    revisions.delete(key);
  };

  const schedule = (browserWindow, immediate = false) => {
    if (!browserWindow || browserWindow.isDestroyed()) return;
    const key = String(browserWindow.id);
    const revision = {};
    revisions.set(key, revision);

    const existingTimer = timers.get(key);
    if (existingTimer !== undefined) {
      clearTimeoutFn(existingTimer);
      timers.delete(key);
    }

    const run = async (expectedTimer) => {
      if (revisions.get(key) !== revision || browserWindow.isDestroyed()) return;
      if (expectedTimer !== undefined && timers.get(key) !== expectedTimer) return;
      if (expectedTimer !== undefined) timers.delete(key);
      try {
        await persist(browserWindow);
      } finally {
        if (revisions.get(key) === revision) revisions.delete(key);
      }
    };

    if (immediate) {
      void run();
      return;
    }

    let timer;
    timer = setTimeoutFn(() => {
      void run(timer);
    }, delayMs);
    timers.set(key, timer);
  };

  return { schedule, cancel };
};
