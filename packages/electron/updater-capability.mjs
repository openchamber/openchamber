import fs from 'node:fs';
import path from 'node:path';

// electron-builder writes this file into the resources of .deb and .rpm builds;
// electron-updater reads the same file to pick its package installer.
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
    // Installed packages update through the system package manager.
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
