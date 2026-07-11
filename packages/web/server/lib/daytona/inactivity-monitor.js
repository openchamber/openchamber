// Inactivity monitor for Daytona sandboxes.
//
// Periodically checks all active sandboxes. If a sandbox has been inactive
// for longer than the configured timeout (default: 10 minutes), it is
// automatically destroyed and the onTimeout callback is invoked.

const CHECK_INTERVAL_MS = 30_000; // 30 seconds

/**
 * @param {{
 *   registry: import('./sandbox-registry.js').ReturnType<typeof import('./sandbox-registry.js').createSandboxRegistry>,
 *   lifecycle: { destroySandbox: (sessionId: string) => Promise<void> },
 *   config: { timeoutMs: number },
 *   logger?: Pick<Console, 'log' | 'warn' | 'error'>,
 *   onTimeout?: (sessionId: string, sandboxId: string) => void,
 * }} dependencies
 */
export const createInactivityMonitor = ({ registry, lifecycle, config, logger = console, onTimeout }) => {
  let intervalHandle = null;

  /**
   * Run one sweep over all active sandboxes and destroy any that have
   * exceeded the inactivity timeout.
   */
  const sweep = async () => {
    const now = Date.now();
    const active = registry.listActive();

    for (const entry of active) {
      const elapsed = now - entry.lastActivityAt;
      if (elapsed >= config.timeoutMs) {
        logger.log(
          `[Daytona] Sandbox ${entry.sandboxId} for session ${entry.sessionId} ` +
          `inactive for ${Math.round(elapsed / 1000)}s (limit: ${Math.round(config.timeoutMs / 1000)}s), destroying...`
        );

        try {
          await lifecycle.destroySandbox(entry.sessionId);
        } catch (error) {
          logger.error(`[Daytona] Failed to destroy inactive sandbox ${entry.sandboxId}: ${error?.message ?? error}`);
        }

        if (typeof onTimeout === 'function') {
          try {
            onTimeout(entry.sessionId, entry.sandboxId);
          } catch (error) {
            logger.warn(`[Daytona] onTimeout callback error for session ${entry.sessionId}: ${error?.message ?? error}`);
          }
        }
      }
    }
  };

  /**
   * Start the periodic inactivity check.
   */
  const start = () => {
    if (intervalHandle) return;
    intervalHandle = setInterval(() => {
      sweep().catch((error) => {
        logger.error(`[Daytona] Inactivity monitor sweep error: ${error?.message ?? error}`);
      });
    }, CHECK_INTERVAL_MS);
    logger.log(`[Daytona] Inactivity monitor started (check every ${CHECK_INTERVAL_MS / 1000}s, timeout: ${config.timeoutMs / 1000}s)`);
  };

  /**
   * Stop the periodic inactivity check.
   */
  const stop = () => {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
      logger.log('[Daytona] Inactivity monitor stopped');
    }
  };

  /**
   * Reset the inactivity timer for a session (called on user activity).
   *
   * @param {string} sessionId
   */
  const resetTimer = (sessionId) => {
    registry.updateActivity(sessionId);
  };

  /**
   * Stop the monitor and clean up.
   */
  const dispose = () => {
    stop();
  };

  return {
    start,
    stop,
    resetTimer,
    dispose,
  };
};
