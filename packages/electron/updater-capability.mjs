import fs from 'node:fs';
import path from 'node:path';

export const assertUpdaterCapability = ({
  platform = process.platform,
  packaged,
  appImagePath = process.env.APPIMAGE,
  access = fs.accessSync,
  stat = fs.statSync,
} = {}) => {
  if (platform !== 'linux' || !packaged) return;

  // RPM installs (and extracted AppImages) have no APPIMAGE env var; skip the
  // updater silently instead of throwing so RPM users see no error on launch.
  if (!appImagePath) return;
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
