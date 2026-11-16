const CRASH_IN_A_ROW_GAP_MS = 2 * 60_000;
const SAFE_START_AT_CRASH = 3;

const RECOVERABLE_REASONS = new Set([
  'abnormal-exit',
  'crashed',
  'oom',
  'memory-eviction',
]);

const RELOAD_DELAY_MS = 100;

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

export const takeSafeStart = (webContents) => pendingSafeStarts.delete(webContents);

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
