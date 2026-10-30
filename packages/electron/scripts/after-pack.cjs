const fs = require('node:fs');
const path = require('node:path');
const { verifyPackagedAppContents } = require('./packaged-app-contents.cjs');

module.exports = (context) => {
  const resourcesPath = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  verifyPackagedAppContents(resourcesPath);
  if (context.electronPlatformName !== 'darwin') return;

  // The compiled catalog sits with the other icons of the build's channel.
  const iconsDir = process.env.OPENCHAMBER_DESKTOP_CHANNEL === 'canary' ? 'icons-canary' : 'icons';
  const sourceAssetsPath = path.join(__dirname, '..', 'resources', iconsDir, 'Assets.car');

  if (!fs.existsSync(sourceAssetsPath)) {
    throw new Error(`Missing compiled app icon asset catalog at ${sourceAssetsPath}`);
  }

  fs.copyFileSync(sourceAssetsPath, path.join(resourcesPath, 'Assets.car'));
};
