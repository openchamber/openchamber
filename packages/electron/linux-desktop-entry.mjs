import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';


const DESKTOP_FILE_NAME = 'openchamber.desktop';
const WM_CLASS = 'openchamber';
const MANAGED_KEY = 'X-OpenChamber-Managed';
const ICON_RELATIVE_PATH = path.join('icons', 'hicolor', '512x512', 'apps', 'openchamber.png');
const APPDIR_ICON_RELATIVE_PATH = path.join('usr', 'share', 'icons', 'hicolor', '512x512', 'apps', 'openchamber.png');

const resolveDataHome = (env, homeDir) => {
  const value = (env.XDG_DATA_HOME ?? '').trim();
  return value && path.isAbsolute(value) ? value : path.join(homeDir, '.local', 'share');
};

// external: https://specifications.freedesktop.org/desktop-entry-spec/latest/exec-variables.html Exec quoting escapes reserved characters and doubles literal percent signs after string-value escaping.
const escapeDesktopString = (value) => value.replace(/\\/g, '\\\\');
const quoteExecArgument = (value) => `"${value.replace(/(["`$\\])/g, '\\$1')}"`.replace(/%/g, '%%');

export const buildAppImageDesktopEntry = ({ appImagePath, iconPath }) => [
  '[Desktop Entry]',
  'Type=Application',
  'Name=OpenChamber',
  'Comment=Desktop runtime for OpenChamber',
  `Exec=${escapeDesktopString(quoteExecArgument(appImagePath))} %U`,
  `TryExec=${escapeDesktopString(appImagePath)}`,
  `Icon=${escapeDesktopString(iconPath)}`,
  'Terminal=false',
  'StartupNotify=true',
  `StartupWMClass=${WM_CLASS}`,
  'Categories=Development;',
  `${MANAGED_KEY}=true`,
  '',
].join('\n');

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

const findForeignEntry = async ({ directory, ownPath, appImagePath }) => {
  let names;
  try {
    names = await fsp.readdir(directory);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith('.desktop')) continue;
    const filePath = path.join(directory, name);
    if (filePath === ownPath) continue;
    const contents = await readFileOrNull(filePath).catch(() => null);
    if (!contents) continue;
    const keys = readDesktopKeys(contents.toString('utf8'));
    if (isManagedEntry(keys)) continue;
    const launchesAppImage = [keys.get('Exec'), keys.get('TryExec')].some((value) => value?.includes(appImagePath));
    if (keys.get('StartupWMClass') === WM_CLASS || launchesAppImage) return filePath;
  }
  return null;
};

const findInstalledPackageEntry = async (env, ownPath) => {
  const dirs = (env.XDG_DATA_DIRS ?? '').trim() || '/usr/local/share:/usr/share';
  for (const dir of dirs.split(':').filter((value) => path.isAbsolute(value))) {
    const filePath = path.join(dir, 'applications', DESKTOP_FILE_NAME);
    if (path.resolve(filePath) === path.resolve(ownPath)) continue;
    if (await readFileOrNull(filePath)) return filePath;
  }
  return null;
};

const writeIfChanged = async (filePath, contents) => {
  const current = await readFileOrNull(filePath);
  if (current && current.equals(contents)) return false;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tempPath, contents, { mode: 0o644 });
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true });
    throw error;
  }
  return true;
};

const removeManagedEntry = async ({ desktopPath, iconPath }) => {
  const contents = await readFileOrNull(desktopPath);
  if (!contents || !isManagedEntry(readDesktopKeys(contents.toString('utf8')))) return false;
  await fsp.rm(desktopPath, { force: true });
  await fsp.rm(iconPath, { force: true });
  return true;
};

export const reconcileAppImageDesktopEntry = async ({
  env = process.env,
  homeDir = os.homedir(),
} = {}) => {
  const dataHome = resolveDataHome(env, homeDir);
  const desktopPath = path.join(dataHome, 'applications', DESKTOP_FILE_NAME);
  const iconPath = path.join(dataHome, ICON_RELATIVE_PATH);

  const appImagePath = (env.APPIMAGE ?? '').trim();
  const appDir = (env.APPDIR ?? '').trim();
  if (!path.isAbsolute(appImagePath) || !path.isAbsolute(appDir) || /[\r\n]/.test(appImagePath)) {
    const installed = await findInstalledPackageEntry(env, desktopPath);
    return { status: 'not-appimage', removed: installed ? await removeManagedEntry({ desktopPath, iconPath }) : false };
  }

  if ((env.DESKTOPINTEGRATION ?? '').trim()) {
    return { status: 'external', removed: await removeManagedEntry({ desktopPath, iconPath }) };
  }

  const ownEntry = await readFileOrNull(desktopPath);
  const ownKeys = ownEntry ? readDesktopKeys(ownEntry.toString('utf8')) : null;
  if (ownKeys && !isManagedEntry(ownKeys)) {
    return { status: 'external', removed: false };
  }
  if (ownKeys && (ownKeys.get('NoDisplay') === 'true' || ownKeys.get('Hidden') === 'true')) {
    return { status: 'hidden-by-user' };
  }

  const foreignEntry = await findInstalledPackageEntry(env, desktopPath)
    ?? await findForeignEntry({ directory: path.dirname(desktopPath), ownPath: desktopPath, appImagePath });
  if (foreignEntry) {
    return { status: 'external', removed: await removeManagedEntry({ desktopPath, iconPath }) };
  }

  const icon = await readFileOrNull(path.join(appDir, APPDIR_ICON_RELATIVE_PATH));
  if (!icon) return { status: 'no-icon' };

  const iconChanged = await writeIfChanged(iconPath, icon);
  const entryChanged = await writeIfChanged(desktopPath, Buffer.from(buildAppImageDesktopEntry({ appImagePath, iconPath }), 'utf8'));
  return { status: 'integrated', changed: iconChanged || entryChanged, desktopPath };
};
