
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
