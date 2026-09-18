import { create } from 'zustand';

export type SessionFailure = {
  name: string | null;
  message: string | null;
  at: number;
};

type SessionFailureStore = {
  failures: ReadonlyMap<string, SessionFailure>;
};

const sessionFailureKey = (directory: string | null | undefined, sessionId: string): string =>
  `${directory ?? ''}\0${sessionId}`;

export const getSessionFailureKey = sessionFailureKey;

export const useSessionFailureStore = create<SessionFailureStore>(() => ({
  failures: new Map(),
}));

export function recordSessionFailure(
  record: Omit<SessionFailure, 'at'> & { directory: string | null | undefined; sessionId: string },
): void {
  const key = sessionFailureKey(record.directory, record.sessionId);
  const failures = new Map(useSessionFailureStore.getState().failures);
  failures.set(key, {
    name: record.name,
    message: record.message,
    at: Date.now(),
  });
  useSessionFailureStore.setState({ failures });
}

export function clearSessionFailure(directory: string | null | undefined, sessionId: string): void {
  const current = useSessionFailureStore.getState().failures;
  const key = sessionFailureKey(directory, sessionId);
  if (!current.has(key)) return;

  const failures = new Map(current);
  failures.delete(key);
  useSessionFailureStore.setState({ failures });
}

export function resetSessionFailureStore(): void {
  if (useSessionFailureStore.getState().failures.size === 0) return;
  useSessionFailureStore.setState({ failures: new Map() });
}

export function useSessionFailures(): ReadonlyMap<string, SessionFailure> {
  return useSessionFailureStore((state) => state.failures);
}
