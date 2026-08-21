import fs from 'node:fs';
import path from 'node:path';

export type SharedSettingsJson = string | number | boolean | null | SharedSettingsJson[] | {
  [key: string]: SharedSettingsJson;
};

export const mergeSharedSettings = <Current, Changes extends object>(current: Current, changes: Changes) => (
  Object.assign({}, current, changes)
);

export const readSharedSettingsFile = (filePath: string): SharedSettingsJson => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (targetError) {
    if (targetError instanceof Error && 'code' in targetError && targetError.code !== 'ENOENT') throw targetError;
    const directory = path.dirname(filePath);
    const backupName = `${path.basename(filePath)}.backup`;
    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch {
      throw targetError;
    }
    const name = names.filter((name) => name === backupName || name.startsWith(`${backupName}-`)).sort().at(-1);
    if (!name) throw targetError;
    try {
      return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    } catch (backupError) {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (retryError) {
        if (retryError instanceof Error && 'code' in retryError && retryError.code !== 'ENOENT') throw retryError;
        throw backupError;
      }
    }
  }
};
