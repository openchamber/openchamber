const RECOVERY_WINDOW_MS = 60_000;
const MAX_RECOVERY_ATTEMPTS = 3;

const RECOVERABLE_REASONS = new Set([
  'abnormal-exit',
  'crashed',
  'oom',
  'memory-eviction',
]);

const RELOAD_DELAY_MS = 100;

export const createRendererRecoveryPolicy = (now = Date.now) => {
  let windowStartedAt = 0;
  let attempts = 0;

  return {
    shouldReload: (reason) => {
      if (!RECOVERABLE_REASONS.has(reason)) return false;

      const currentTime = now();
      if (currentTime - windowStartedAt >= RECOVERY_WINDOW_MS) {
        windowStartedAt = currentTime;
        attempts = 0;
      }
      if (attempts >= MAX_RECOVERY_ATTEMPTS) return false;

      attempts += 1;
      return true;
    },
  };
};

/**
 * Reload a window whose renderer process died, within the recovery budget.
 * Shared by every BrowserWindow so the desktop shell has one recovery policy.
 */
export const attachRendererRecovery = (browserWindow, { log, label }) => {
  const policy = createRendererRecoveryPolicy();
  browserWindow.webContents.on('render-process-gone', (_event, details) => {
    if (!policy.shouldReload(details.reason)) return;
    log.warn('[electron] renderer exited unexpectedly; reloading window', {
      label: browserWindow.__ocLabel,
      surface: label,
      reason: details.reason,
      exitCode: details.exitCode,
    });
    setTimeout(() => {
      if (!browserWindow.isDestroyed()) {
        browserWindow.webContents.reload();
      }
    }, RELOAD_DELAY_MS);
  });
};
