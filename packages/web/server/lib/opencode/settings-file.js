import path from 'node:path';

const latestBackupName = (names, filePath) => {
  const backupName = `${path.basename(filePath)}.backup`;
  return names.filter((name) => name === backupName || name.startsWith(`${backupName}-`)).sort().at(-1);
};

export const readJsonFileWithBackup = async (fsPromises, filePath) => {
  try {
    return JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
  } catch (targetError) {
    if (targetError?.code !== 'ENOENT') throw targetError;
    const directory = path.dirname(filePath);
    let names;
    try {
      names = await fsPromises.readdir(directory);
    } catch {
      throw targetError;
    }
    const name = latestBackupName(names, filePath);
    if (!name) throw targetError;
    try {
      return JSON.parse(await fsPromises.readFile(path.join(directory, name), 'utf8'));
    } catch (backupError) {
      try {
        return JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
      } catch (retryError) {
        if (retryError?.code !== 'ENOENT') throw retryError;
        throw backupError;
      }
    }
  }
};

export const readJsonFileWithBackupSync = (fs, filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (targetError) {
    if (targetError?.code !== 'ENOENT') throw targetError;
    const directory = path.dirname(filePath);
    let names;
    try {
      names = fs.readdirSync(directory);
    } catch {
      throw targetError;
    }
    const name = latestBackupName(names, filePath);
    if (!name) throw targetError;
    try {
      return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    } catch (backupError) {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (retryError) {
        if (retryError?.code !== 'ENOENT') throw retryError;
        throw backupError;
      }
    }
  }
};
