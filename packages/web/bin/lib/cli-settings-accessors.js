export const createSettingsAccessors = ({ fsPromises, path, dataDir, settingsFileName }) => {
  const settingsPath = path.join(dataDir, settingsFileName);

  const readSettingsFromDiskMigrated = async () => {
    try {
      return JSON.parse(await fsPromises.readFile(settingsPath, 'utf8'));
    } catch {
      return {};
    }
  };

  const readSettingsStrict = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(settingsPath, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return {};
      }
      throw error;
    }
    const corruptSettingsError = (cause) =>
      new Error(`Settings file is corrupt or unreadable: ${settingsPath} (fix or remove it, then retry)`, { cause });

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw corruptSettingsError(error);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw corruptSettingsError(new Error('non-object payload'));
    }
    return parsed;
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const isTransientWindowsReplaceError = (error) => {
    if (process.platform !== 'win32' || !error || typeof error !== 'object') {
      return false;
    }
    return error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY';
  };

  const replaceFile = async (tmp, target) => {
    const maxAttempts = process.platform === 'win32' ? 6 : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await fsPromises.rename(tmp, target);
        return;
      } catch (error) {
        lastError = error;
        if (!isTransientWindowsReplaceError(error) || attempt === maxAttempts) {
          break;
        }
        await sleep(25 * attempt);
      }
    }

    if (!isTransientWindowsReplaceError(lastError)) {
      throw lastError;
    }

    await fsPromises.copyFile(tmp, target);
    await fsPromises.rm(tmp, { force: true });
  };

  const writeSettingsToDisk = async (settings) => {
    await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
    const tmp = `${settingsPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fsPromises.writeFile(tmp, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') {
      await fsPromises.chmod(tmp, 0o600);
    }
    await replaceFile(tmp, settingsPath);
    if (process.platform !== 'win32') {
      await fsPromises.chmod(settingsPath, 0o600);
    }
  };

  return { readSettingsFromDiskMigrated, readSettingsStrict, writeSettingsToDisk };
};
