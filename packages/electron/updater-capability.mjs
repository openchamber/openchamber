import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DIRECT_CONTENTS_KEY = 'SquirrelMacEnableDirectContentsWrite';

const isWritable = (access, target) => {
  try {
    access(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const listMacosEntries = (targets) => execFileSync('/bin/ls', ['-ldenO', '--', ...targets], { encoding: 'utf8' });

const hasPlainPermissions = (list, targets) => {
  const lines = list(targets).split('\n').filter((line) => line.trim() !== '');
  if (lines.length !== targets.length) return false;
  return lines.every((line) => {
    const [mode = '', , , , flags] = line.trim().split(/\s+/);
    return mode.length >= 10 && !/[tT]/.test(mode[9]) && flags === '-';
  });
};

export const enableMacosDirectContentsUpdates = ({
  app,
  systemPreferences,
  platform = process.platform,
  access = fs.accessSync,
  realpath = fs.realpathSync,
  list = listMacosEntries,
}) => {
  if (platform !== 'darwin') return;

  try {
    if (systemPreferences.getUserDefault(DIRECT_CONTENTS_KEY, 'string') !== '') return;

    const contentsPath = realpath(path.dirname(path.dirname(app.getPath('exe'))));
    const bundlePath = path.dirname(contentsPath);
    if (path.basename(contentsPath) !== 'Contents' || path.extname(bundlePath) !== '.app') return;
    if (!isWritable(access, bundlePath) || !isWritable(access, contentsPath)) return;
    if (isWritable(access, path.dirname(bundlePath))) return;
    if (!hasPlainPermissions(list, [bundlePath, contentsPath])) return;

    systemPreferences.setUserDefault(DIRECT_CONTENTS_KEY, 'boolean', true);
  } catch {
    return;
  }
};

export const readLinuxPackageType = (resourcesPath = process.resourcesPath) => {
  try {
    return fs.readFileSync(path.join(resourcesPath, 'package-type'), 'utf8').trim();
  } catch {
    return '';
  }
};

export const assertUpdaterCapability = ({
  platform = process.platform,
  packaged,
  appImagePath = process.env.APPIMAGE,
  packageType = readLinuxPackageType(),
  access = fs.accessSync,
  stat = fs.statSync,
} = {}) => {
  if (platform !== 'linux' || !packaged) return;

  if (!appImagePath) {
    if (packageType === 'deb' || packageType === 'rpm') return;
    throw new Error(
      'Updates require the packaged Linux AppImage, .deb or .rpm. Start OpenChamber from its .AppImage file or install a package, not an extracted or repackaged copy.',
    );
  }
  if (!path.isAbsolute(appImagePath)) {
    throw new Error(`Updates require APPIMAGE to be an absolute path, got: ${appImagePath}`);
  }

  try {
    if (!stat(appImagePath).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`The running AppImage cannot be found at ${appImagePath}. Start OpenChamber from a valid .AppImage file.`);
  }

  try {
    access(appImagePath, fs.constants.W_OK);
  } catch {
    throw new Error(
      `The AppImage is not writable at ${appImagePath}. Move it to a writable location or grant write permission before updating.`,
    );
  }
};
