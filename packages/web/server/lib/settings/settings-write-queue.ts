import type { SettingsDocument } from './settings-helpers.js';

export type UpdateSettingsFromDisk = <Next extends SettingsDocument>(
  mutate: (current: SettingsDocument) => Next | Promise<Next>,
) => Promise<Next>;

const isCallable = (value: unknown): value is (...args: never[]) => void => typeof value === 'function';

export const createSettingsWriteQueue = (
  readSettingsFromDiskMigrated: () => Promise<SettingsDocument>,
  writeSettingsToDisk: (settings: SettingsDocument) => Promise<void>,
  exclusiveSave: <Result>(save: () => Promise<Result>) => Promise<Result>,
) => {
  let pending: Promise<unknown> = Promise.resolve();
  let unfinished = 0;

  const enqueue = <Result>(write: () => Promise<Result>) => {
    unfinished += 1;
    const result = pending.then(write).finally(() => { unfinished -= 1; });
    pending = result.catch(() => {});
    return result;
  };

  const updateSettingsFromDisk: UpdateSettingsFromDisk = async (mutate) => {
    if (!isCallable(mutate)) {
      throw new TypeError('updateSettingsFromDisk needs a mutate function');
    }
    return enqueue(() => exclusiveSave(async () => {
      const current = await readSettingsFromDiskMigrated();
      const next = await mutate(current);
      if (next !== current) {
        await writeSettingsToDisk(next);
      }
      return next;
    }));
  };

  return { enqueue, updateSettingsFromDisk, isIdle: () => unfinished === 0 };
};
