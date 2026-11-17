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
