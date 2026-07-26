import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const AUTOSTART_FILE_NAME = 'openchamber.desktop';

export const resolveLinuxAutostartDirectory = ({
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

export const buildLinuxAutostartDesktopEntry = ({
  appName = 'OpenChamber',
  executable,
  backgroundArg,
  env = process.env,
  execPath = process.execPath,
} = {}) => {
  const launchPath = executable || resolveLinuxLaunchExecutable({ env, execPath });
  const args = [quoteDesktopExecArg(launchPath)];
  if (typeof backgroundArg === 'string' && backgroundArg.trim()) {
    args.push(backgroundArg.trim());
  }
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${appName}`,
    `Exec=${args.join(' ')}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'StartupWMClass=openchamber',
    '',
  ].join('\n');
};

export const readLinuxAutostartEnabled = async (options = {}) => {
  const filePath = resolveLinuxAutostartFilePath(options);
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
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

  if (!enabled) {
    await fsp.rm(filePath, { force: true });
    return { supported: true, enabled: false, filePath };
  }

  await fsp.mkdir(directory, { recursive: true });
  const contents = buildLinuxAutostartDesktopEntry({
    appName,
    backgroundArg,
    env,
    execPath,
  });
  await fsp.writeFile(filePath, contents, 'utf8');
  return { supported: true, enabled: true, filePath };
};
