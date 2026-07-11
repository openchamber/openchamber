export type TrayStatusSnapshot = Record<string, { type?: string }>;

type RefreshTrayStatusTargetsInput = {
  targets: ReadonlyMap<string, readonly string[]>;
  isReady: () => boolean;
  fetchStatus: (directory: string) => Promise<TrayStatusSnapshot | null>;
  applySnapshot: (
    directory: string,
    snapshot: TrayStatusSnapshot,
    sessionIds: readonly string[],
  ) => void;
  concurrency?: number;
  isDisposed?: () => boolean;
};

/**
 * Reconcile the tray's event-driven status cache without creating a cold-start
 * request fan-out. Readiness is checked before scheduling and again before
 * each worker starts another directory, because the runtime can disconnect
 * while a previous status request is in flight.
 */
export async function refreshTrayStatusTargets({
  targets,
  isReady,
  fetchStatus,
  applySnapshot,
  concurrency = 2,
  isDisposed = () => false,
}: RefreshTrayStatusTargetsInput): Promise<void> {
  if (!isReady() || isDisposed()) return;

  const entries = [...targets.entries()];
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), entries.length);

  const worker = async () => {
    while (cursor < entries.length && isReady() && !isDisposed()) {
      const entry = entries[cursor];
      cursor += 1;
      if (!entry) return;

      const [directory, sessionIds] = entry;
      const snapshot = await fetchStatus(directory);
      if (snapshot === null || isDisposed()) continue;
      applySnapshot(directory, snapshot, sessionIds);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
