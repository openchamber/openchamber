import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// GNOME 46+ shows a window's icon only through a .desktop file whose name or
// StartupWMClass matches the window's app id; a window without one gets the
// generic executable icon, on Wayland and XWayland alike. An AppImage started
// from a file manager has no such file, so the packaged app writes its own
// unless another integration (Gear Lever, AppImageLauncher, appimaged) owns it.
// GNOME re-matches open windows when the file appears, so the first launch
// gets the icon a few seconds after this runs.

// .desktop entries are a few-KiB stubs: 512 KiB matches MAX_FAVICON_BYTES in
// main.mjs (#817) and MAX_INSTALLED_APP_ICON_BYTES (#1257) — keep the 512 KiB
// caps in sync, including MAX_DESKTOP_ENTRY_BYTES in linux-app-discovery.mjs,
// whose value this duplicates. Only the findForeignEntry directory scan is
// gated at this cap; reads of our own entry file at its fixed path are not.
export const MAX_DESKTOP_ENTRY_BYTES = 512 * 1024;

const DESKTOP_FILE_NAME = 'openchamber.desktop';
const WM_CLASS = 'openchamber';
const MANAGED_KEY = 'X-OpenChamber-Managed';
const ICON_RELATIVE_PATH = path.join('icons', 'hicolor', '512x512', 'apps', 'openchamber.png');
const APPDIR_ICON_RELATIVE_PATH = path.join('usr', 'share', 'icons', 'hicolor', '512x512', 'apps', 'openchamber.png');

const resolveDataHome = (env, homeDir) => {
  const value = (env.XDG_DATA_HOME ?? '').trim();
  return value && path.isAbsolute(value) ? value : path.join(homeDir, '.local', 'share');
};

// Desktop Entry spec: a string value escapes backslashes; an Exec argument is
// double-quoted with ", `, $ and \ escaped, and a literal % is written %%.
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

const readFileOrNull = async (filePath, { maxBytes } = {}) => {
  try {
    if (maxBytes && (await fsp.stat(filePath)).size > maxBytes) return null;
    return await fsp.readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
};

// Another launcher entry for this app in the user's applications folder, where
// Gear Lever, AppImageLauncher and appimaged write theirs: one that claims our
// window class, or one that starts this very AppImage.
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
    const contents = await readFileOrNull(filePath, { maxBytes: MAX_DESKTOP_ENTRY_BYTES }).catch(() => null);
    if (!contents) continue;
    const keys = readDesktopKeys(contents.toString('utf8'));
    if (isManagedEntry(keys)) continue;
    const launchesAppImage = [keys.get('Exec'), keys.get('TryExec')].some((value) => value?.includes(appImagePath));
    if (keys.get('StartupWMClass') === WM_CLASS || launchesAppImage) return filePath;
  }
  return null;
};

// The .deb and .rpm install their entry under the same name in a system data
// directory; a user entry would hide it.
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

/**
 * Keeps the user's launcher entry for a running AppImage in step with it:
 * written when nothing else integrates the app, rewritten when the AppImage
 * moved (in-app updates may rename it), and withdrawn once another
 * integration appears. Files without our marker are never touched.
 * Runs only in packaged Linux builds.
 */
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
    // An installed .deb or .rpm ships its own openchamber.desktop, which an
    // entry left by an earlier AppImage run would hide: ours takes precedence.
    // An extracted AppImage also runs without APPIMAGE; it keeps the entry.
    const installed = await findInstalledPackageEntry(env, desktopPath);
    return { status: 'not-appimage', removed: installed ? await removeManagedEntry({ desktopPath, iconPath }) : false };
  }

  // Gear Lever and the old AppImageKit integration launch with this set.
  if ((env.DESKTOPINTEGRATION ?? '').trim()) {
    return { status: 'external', removed: await removeManagedEntry({ desktopPath, iconPath }) };
  }

  const ownEntry = await readFileOrNull(desktopPath);
  const ownKeys = ownEntry ? readDesktopKeys(ownEntry.toString('utf8')) : null;
  if (ownKeys && !isManagedEntry(ownKeys)) {
    return { status: 'external', removed: false };
  }
  // Menu editors hide an entry by writing one of these keys into it.
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

  // Icon first: GNOME reads the entry as soon as it appears.
  const iconChanged = await writeIfChanged(iconPath, icon);
  const entryChanged = await writeIfChanged(desktopPath, Buffer.from(buildAppImageDesktopEntry({ appImagePath, iconPath }), 'utf8'));
  return { status: 'integrated', changed: iconChanged || entryChanged, desktopPath };
};
