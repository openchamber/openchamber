import { normalizeSettingsSurface } from './settings-files.js';
import type { SettingsSurface } from './settings-files.js';
import { SettingsWriteConflict } from './settings-file-state.js';
import type { createExclusiveSettingsSave } from './settings-exclusive-save.js';
import type { SettingsDocument } from './settings-helpers.js';
import { createSettingsWriteQueue } from './settings-write-queue.js';

type ReadOptions = { surface?: SettingsSurface | null };

export const createMigratedSettingsReader = ({ cleanupTempFiles, readSettings, readMigratedSettings, writeSettings, exclusive }: {
  exclusive: Pick<ReturnType<typeof createExclusiveSettingsSave>, 'withLock' | 'exclusiveSave'>;
  cleanupTempFiles: () => Promise<void>;
  readSettings: (options?: ReadOptions) => Promise<SettingsDocument>;
  readMigratedSettings: (options?: ReadOptions) => Promise<{ settings: SettingsDocument; writable: boolean }>;
  writeSettings: (settings: SettingsDocument) => Promise<void>;
}) => {
  let cleaned = false;
  let migrationWrite: Promise<void> | null = null;

  const writeMigration = () => {
    if (!migrationWrite && queue.isIdle()) {
      migrationWrite = queue.enqueue(() => exclusive.withLock(async () => {
        const { settings, writable } = await readMigratedSettings();
        if (writable) await writeSettings(settings);
      })).catch((error) => { if (!(error instanceof SettingsWriteConflict)) throw error; }).finally(() => { migrationWrite = null; });
    }
    return migrationWrite;
  };

  const readSettingsFromDiskMigrated = async ({ surface = null }: ReadOptions = {}): Promise<SettingsDocument> => {
    if (!cleaned) {
      cleaned = true;
      await cleanupTempFiles();
    }
    const { settings, writable } = await readMigratedSettings();
    const write = writable ? writeMigration() : null;
    await write;
    if (!normalizeSettingsSurface(surface)) return settings;
    const deferred = writable && !write;
    return deferred ? (await readMigratedSettings({ surface })).settings : readSettings({ surface });
  };

  const queue = createSettingsWriteQueue(readSettingsFromDiskMigrated, writeSettings, exclusive.exclusiveSave);
  return { readSettingsFromDiskMigrated, enqueue: queue.enqueue, updateSettingsFromDisk: queue.updateSettingsFromDisk };
};
