import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { SettingsWriteConflict } from './settings-file-state.js';
import { createExternalSettingsReconciler } from './settings-reconciliation.js';
import type { SettingsFileChange } from './settings-file-state.js';
import type { createSettingsWriteQueue } from './settings-write-queue.js';

const LOCK_WAIT_MS = 10_000;
const SAVE_ATTEMPTS = 5;

type TakenInListener = (changes: SettingsFileChange[]) => void;

type ReconcilerOptions = Parameters<typeof createExternalSettingsReconciler>[0];

export const createExclusiveSettingsSave = (options: ReconcilerOptions) => {
  const { settingsFileState, settingsFilePath } = options;
  const lockPath = `${settingsFilePath}.lock`;
  const takeIn = createExternalSettingsReconciler(options);
  const listeners = new Set<TakenInListener>();
  const withLock = <Result>(operation: () => Promise<Result>) => withSourceControlFileLock(lockPath, operation, { waitMs: LOCK_WAIT_MS });

  const takeInPending = async () => {
    await settingsFileState.readForWrite('settings');
    await settingsFileState.readForWrite('preferences');
    const source = (['settings', 'preferences'] as const).find((key) => settingsFileState.hasUnreportedChanges(key));
    if (!source) return;
    const changes = await takeIn({ source, changedKeys: settingsFileState.getPendingChangedKeys(source) });
    if (changes.length > 0) for (const listener of listeners) listener(changes);
  };

  const exclusiveSave = <Result>(save: (attempt: number) => Promise<Result>) => withLock(async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await takeInPending();
        return await save(attempt);
      } catch (error) {
        if (!(error instanceof SettingsWriteConflict) || attempt === SAVE_ATTEMPTS) throw error;
      }
    }
  });

  const subscribeTakenIn = (listener: TakenInListener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };

  const createReconcile = (enqueue: ReturnType<typeof createSettingsWriteQueue>['enqueue']) => (
    (change: SettingsFileChange) => enqueue(() => withLock(() => takeIn(change)))
  );

  return { withLock, exclusiveSave, subscribeTakenIn, createReconcile };
};
