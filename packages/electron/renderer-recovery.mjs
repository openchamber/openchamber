// A crash counts as "in a row" when it comes within this long of the previous
// one. Issue 4907 crashed every 20-45 s after each reload.
const CRASH_IN_A_ROW_GAP_MS = 2 * 60_000;
// The crash in a row whose reload skips the saved layout.
const SAFE_START_AT_CRASH = 3;

const RECOVERABLE_REASONS = new Set([
  'abnormal-exit',
  'crashed',
  'oom',
  'memory-eviction',
]);

const RELOAD_DELAY_MS = 100;

/**
 * Decide what follows a renderer exit: `reload`, `safe-start` (reload without
 * the saved layout), `stop` (leave the window as it is), or `ignore`.
 */
export const createRendererRecoveryPolicy = (now = Date.now) => {
  let lastCrashAt = -Infinity;
  let crashesInARow = 0;

  return {
    nextStep: (reason) => {
      if (!RECOVERABLE_REASONS.has(reason)) return 'ignore';

      const currentTime = now();
      crashesInARow = currentTime - lastCrashAt < CRASH_IN_A_ROW_GAP_MS ? crashesInARow + 1 : 1;
      lastCrashAt = currentTime;

      if (crashesInARow < SAFE_START_AT_CRASH) return 'reload';
      if (crashesInARow === SAFE_START_AT_CRASH) return 'safe-start';
      return 'stop';
    },
  };
};

const pendingSafeStarts = new WeakSet();

/**
 * True once for the page that loads after a safe-start reload; preload asks
 * before any page script runs, so the UI starts without its saved layout.
 */
export const takeSafeStart = (webContents) => pendingSafeStarts.delete(webContents);

/**
 * Reload a window whose renderer process died. A restored layout that crashes
 * the window on every load would loop forever, so the third crash in a row
 * reloads without it and a fourth leaves the window alone.
 * Shared by every BrowserWindow so the desktop shell has one recovery policy.
 */
export const attachRendererRecovery = (browserWindow, { log, label }) => {
  const policy = createRendererRecoveryPolicy();
  browserWindow.webContents.on('render-process-gone', (_event, details) => {
    const step = policy.nextStep(details.reason);
    if (step === 'ignore') return;

    const payload = {
      label: browserWindow.__ocLabel,
      surface: label,
      reason: details.reason,
      exitCode: details.exitCode,
    };
    if (step === 'stop') {
      log.warn('[electron] renderer keeps crashing after a safe start; no more reloads', payload);
      return;
    }
    if (step === 'safe-start') {
      pendingSafeStarts.add(browserWindow.webContents);
      log.warn('[electron] renderer keeps crashing; reloading window without its saved layout', payload);
    } else {
      log.warn('[electron] renderer exited unexpectedly; reloading window', payload);
    }
    setTimeout(() => {
      if (!browserWindow.isDestroyed()) {
        browserWindow.webContents.reload();
      }
    }, RELOAD_DELAY_MS);
  });
};
