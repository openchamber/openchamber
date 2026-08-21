import fs from 'node:fs';

export type SharedSettingsJson = string | number | boolean | null | SharedSettingsJson[] | {
  [key: string]: SharedSettingsJson;
};

export const mergeSharedSettings = <Changes extends object>(current: SharedSettingsJson, changes: Changes) => (
  Object.assign({}, current, changes)
);

export const readSharedSettingsFile = (filePath: string): SharedSettingsJson => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (targetError) {
    if (targetError instanceof Error && 'code' in targetError && targetError.code !== 'ENOENT') throw targetError;
    try {
      return JSON.parse(fs.readFileSync(`${filePath}.backup`, 'utf8'));
    } catch (backupError) {
      if (backupError instanceof Error && 'code' in backupError && backupError.code === 'ENOENT') throw targetError;
      throw backupError;
    }
  }
};
