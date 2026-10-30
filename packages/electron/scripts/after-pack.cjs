const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Arch } = require('electron-builder');
const { setExecutableUuid } = require('./macos-executable-uuid.cjs');
const { verifyPackagedAppContents } = require('./packaged-app-contents.cjs');

module.exports = (context) => {
  const { appInfo } = context.packager;
  const contentsPath = path.join(context.appOutDir, `${appInfo.productFilename}.app`, 'Contents');
  const resourcesPath = context.electronPlatformName === 'darwin'
    ? path.join(contentsPath, 'Resources')
    : path.join(context.appOutDir, 'resources');
  verifyPackagedAppContents(resourcesPath, { platform: context.electronPlatformName, arch: Arch[context.arch] });
  if (context.electronPlatformName !== 'darwin') return;

  const executablePath = path.join(contentsPath, 'MacOS', appInfo.productFilename);
  setExecutableUuid(executablePath, appInfo.id);
  // The new UUID breaks Electron's ad-hoc signature, and arm64 kills an
  // executable with a broken one. Re-sign ad hoc so builds that skip signing
  // still launch; electron-builder's own signing replaces this.
  execFileSync('codesign', ['--force', '--sign', '-', executablePath], { stdio: 'inherit' });

  const sourceAssetsPath = path.join(__dirname, '..', 'resources', 'icons', 'Assets.car');

  if (!fs.existsSync(sourceAssetsPath)) {
    throw new Error(`Missing compiled app icon asset catalog at ${sourceAssetsPath}`);
  }

  fs.copyFileSync(sourceAssetsPath, path.join(resourcesPath, 'Assets.car'));
};
