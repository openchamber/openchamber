export const readJsonFileWithBackup = async (fsPromises, filePath) => {
  try {
    return JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
  } catch (targetError) {
    if (targetError?.code !== 'ENOENT') throw targetError;
    try {
      return JSON.parse(await fsPromises.readFile(`${filePath}.backup`, 'utf8'));
    } catch (backupError) {
      if (backupError?.code === 'ENOENT') throw targetError;
      throw backupError;
    }
  }
};

export const readJsonFileWithBackupSync = (fs, filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (targetError) {
    if (targetError?.code !== 'ENOENT') throw targetError;
    try {
      return JSON.parse(fs.readFileSync(`${filePath}.backup`, 'utf8'));
    } catch (backupError) {
      if (backupError?.code === 'ENOENT') throw targetError;
      throw backupError;
    }
  }
};
