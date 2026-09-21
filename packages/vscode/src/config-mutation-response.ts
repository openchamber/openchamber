/**
 * Shared response shape for OpenCode config mutations.
 *
 * Settings writes persist to disk immediately but defer the OpenCode restart
 * so the UI can accumulate pending changes and apply them once via
 * api:config/reload ("Apply & Restart OpenCode").
 */
export function buildDeferredRestartResponse(message: string) {
  return {
    success: true,
    requiresReload: false,
    requiresRestart: true,
    restartDeferred: true,
    message,
  };
}
