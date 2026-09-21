/**
 * The last error behind a failed session action, keyed by session id.
 *
 * Archive, restore and delete return booleans and id lists through the store
 * contract shared with the sidebar rows, the bulk bar and the mobile sheet.
 * That contract says *which* sessions failed, not *why*. The why is recorded
 * here at the catch site and taken once by whichever surface reports the
 * failure, so a toast can quote what OpenCode answered instead of a bare
 * "failed". Entries are consumed on read and bounded, so a failure nobody
 * reports does not accumulate.
 */
const MAX_RECORDED_FAILURES = 200;

const failures = new Map<string, Error>();

export const recordSessionActionFailure = (sessionId: string, error: Error): void => {
  failures.delete(sessionId);
  failures.set(sessionId, error);
  while (failures.size > MAX_RECORDED_FAILURES) {
    const oldest = failures.keys().next().value;
    if (oldest === undefined) break;
    failures.delete(oldest);
  }
};

/** Take (and forget) the first recorded error among the given sessions. */
export const takeSessionActionFailure = (sessionIds: readonly string[]): Error | null => {
  let found: Error | null = null;
  for (const id of sessionIds) {
    const error = failures.get(id);
    if (error && !found) found = error;
    failures.delete(id);
  }
  return found;
};

export const resetSessionActionFailures = (): void => {
  failures.clear();
};
