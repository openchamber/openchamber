// Electron reports every failed webview navigation as a process warning of
// type `electron` ("Failed to load URL: <url> with error: <code>"). Node prints
// warnings through console.error, so each one lands in main.log at error level.
// While the browser panel waits for a local dev server it retries the refused
// URL every 600 ms, which turns one wait into dozens of identical lines.
// Report the first failure per URL and error, and demote repeats inside the
// window so genuine errors stay visible.

const LOAD_FAILURE_PREFIX = 'Failed to load URL: ';
export const LOAD_FAILURE_REPEAT_WINDOW_MS = 60_000;

export const createLoadFailureWarningFilter = ({ now = Date.now, windowMs = LOAD_FAILURE_REPEAT_WINDOW_MS } = {}) => {
  const lastReportedAt = new Map();

  return (warning) => {
    if (warning?.name !== 'electron' || !String(warning.message).startsWith(LOAD_FAILURE_PREFIX)) return true;

    const at = now();
    for (const [key, reportedAt] of lastReportedAt) {
      if (at - reportedAt >= windowMs) lastReportedAt.delete(key);
    }
    if (lastReportedAt.has(warning.message)) return false;
    lastReportedAt.set(warning.message, at);
    return true;
  };
};
