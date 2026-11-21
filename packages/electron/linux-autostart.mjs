import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const AUTOSTART_FILE_NAME = 'openchamber.desktop';
const MANAGED_KEY = 'X-OpenChamber-Managed';

const resolveLinuxAutostartDirectory = ({
  env = process.env,
  homeDir = os.homedir(),
} = {}) => {
  const configHome = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : path.join(homeDir || os.homedir(), '.config');
  return path.join(configHome, 'autostart');
};

export const resolveLinuxAutostartFilePath = (options = {}) =>
  path.join(resolveLinuxAutostartDirectory(options), AUTOSTART_FILE_NAME);

export const resolveLinuxLaunchExecutable = ({
  env = process.env,
  execPath = process.execPath,
} = {}) => {
  const appImage = typeof env.APPIMAGE === 'string' ? env.APPIMAGE.trim() : '';
  if (appImage && path.isAbsolute(appImage)) {
    return appImage;
  }
  return execPath;
};

const quoteDesktopExecArg = (value) => {
  const text = String(value ?? '');
  if (!/[ \t\n"$\\]/.test(text)) {
    return text;
  }
  return `"${text.replace(/(["\\$`])/g, '\\$1')}"`;
};

// Desktop Entry spec: keys are local to their group, and within a group the
// first occurrence of a key is the one that counts.
const readDesktopKeys = (contents) => {
  const keys = new Map();
  let inMainGroup = false;
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inMainGroup = line === '[Desktop Entry]';
      continue;
    }
    const separator = line.indexOf('=');
    if (!inMainGroup || separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!keys.has(key)) keys.set(key, line.slice(separator + 1).trim());
  }
  return keys;
};

const isManagedEntry = (keys) => keys.get(MANAGED_KEY) === 'true';

const readFileOrNull = async (filePath) => {
  try {
    return await fsp.readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
};

// Menu editors disable an autostart entry with these keys; the app treats them
// as the user's answer and does not resurrect the entry behind their back.
const isHiddenByUser = (keys) => keys.get('Hidden') === 'true' || keys.get('NoDisplay') === 'true'
  || keys.get('X-GNOME-Autostart-enabled') === 'false';

const clearUserDisabledMarkers = (contents) => {
  let inMainGroup = false;
  return contents.split('\n').filter((rawLine) => {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inMainGroup = line === '[Desktop Entry]';
      return true;
    }
    if (!inMainGroup) return true;
    const separator = line.indexOf('=');
    if (separator <= 0) return true;
    const key = line.slice(0, separator).trim();
    return !((key === 'Hidden' || key === 'NoDisplay') && line.slice(separator + 1).trim() === 'true');
  }).join('\n');
};

/**
 * Rewrites the managed keys inside the existing entry and leaves every other
 * line, and every line outside the main group, exactly as it was. Managed keys
 * are replaced where they stand and appended once at the end of the group when
 * missing, so the entry never grows duplicate keys.
 */
const applyManagedKeys = (contents, managedKeys) => {
  const lines = contents.split('\n');
  const output = [];
  const written = new Set();
  let inMainGroup = false;
  let sawMainGroup = false;
  const appendMissingManagedKeys = () => {
    for (const [key, value] of managedKeys) {
      if (written.has(key)) continue;
      output.push(`${key}=${value}`);
      written.add(key);
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      if (inMainGroup) appendMissingManagedKeys();
      inMainGroup = line === '[Desktop Entry]';
      sawMainGroup ||= inMainGroup;
      output.push(rawLine);
      continue;
    }
    const separator = line.indexOf('=');
    if (inMainGroup && separator > 0 && managedKeys.has(line.slice(0, separator).trim())) {
      const key = line.slice(0, separator).trim();
      if (!written.has(key)) {
        output.push(`${key}=${managedKeys.get(key)}`);
        written.add(key);
      }
      continue;
    }
    output.push(rawLine);
  }
  if (inMainGroup) appendMissingManagedKeys();
  if (!sawMainGroup) {
    output.unshift('[Desktop Entry]', ...[...managedKeys].map(([key, value]) => `${key}=${value}`));
  }
  return `${output.join('\n').replace(/\n*$/, '')}\n`;
};

export const buildLinuxAutostartDesktopEntry = ({
  appName = 'OpenChamber',
  executable,
  backgroundArg,
  env = process.env,
  execPath = process.execPath,
  previousContents,
} = {}) => {
  const launchPath = executable || resolveLinuxLaunchExecutable({ env, execPath });
  const args = [quoteDesktopExecArg(launchPath)];
  if (typeof backgroundArg === 'string' && backgroundArg.trim()) {
    args.push(backgroundArg.trim());
  }
  const managedKeys = new Map([
    ['Type', 'Application'],
    ['Name', appName],
    ['Exec', args.join(' ')],
    ['Terminal', 'false'],
    ['X-GNOME-Autostart-enabled', 'true'],
    ['StartupWMClass', 'openchamber'],
    [MANAGED_KEY, 'true'],
  ]);
  return applyManagedKeys(previousContents ?? '', managedKeys);
};

const readAutostartEntry = async (options = {}) => {
  const contents = await readFileOrNull(resolveLinuxAutostartFilePath(options));
  if (!contents) return null;
  const text = contents.toString('utf8');
  return { contents: text, keys: readDesktopKeys(text) };
};

export const readLinuxAutostartEnabled = async (options = {}) => {
  const entry = await readAutostartEntry(options);
  if (!entry) return false;
  // An entry we did not write belongs to the user or another tool; report it
  // as enabled without touching it.
  if (!isManagedEntry(entry.keys)) return true;
  return !isHiddenByUser(entry.keys);
};

const writeIfChanged = async (filePath, contents) => {
  const current = await readFileOrNull(filePath);
  if (current && current.equals(Buffer.from(contents, 'utf8'))) return false;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tempPath, contents, 'utf8');
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true });
    throw error;
  }
  return true;
};

export const setLinuxAutostartEnabled = async ({
  enabled,
  appName = 'OpenChamber',
  backgroundArg,
  env = process.env,
  execPath = process.execPath,
  homeDir = os.homedir(),
} = {}) => {
  const directory = resolveLinuxAutostartDirectory({ env, homeDir });
  const filePath = path.join(directory, AUTOSTART_FILE_NAME);
  const entry = await readAutostartEntry({ env, homeDir });
  // The entry was written by the user or another integration under the same
  // name: leave it exactly as it is and report the toggle unsupported.
  if (entry && !isManagedEntry(entry.keys)) {
    return { supported: false, enabled: enabled === true, filePath, foreignEntry: true };
  }

  if (!enabled) {
    await fsp.rm(filePath, { force: true });
    return { supported: true, enabled: false, filePath };
  }

  const contents = buildLinuxAutostartDesktopEntry({
    appName,
    backgroundArg,
    env,
    execPath,
    previousContents: entry ? clearUserDisabledMarkers(entry.contents) : undefined,
  });
  await writeIfChanged(filePath, contents);
  return { supported: true, enabled: true, filePath };
};
