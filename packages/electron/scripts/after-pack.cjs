const fs = require('node:fs');
const path = require('node:path');

module.exports = (context) => {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appBundlePath = path.join(context.appOutDir, `${appName}.app`);
  const resourcesPath = path.join(appBundlePath, 'Contents', 'Resources');
  const sourceAssetsPath = path.join(__dirname, '..', 'resources', 'icons', 'Assets.car');

  if (!fs.existsSync(sourceAssetsPath)) {
    throw new Error(`Missing compiled app icon asset catalog at ${sourceAssetsPath}`);
  }

  fs.copyFileSync(sourceAssetsPath, path.join(resourcesPath, 'Assets.car'));
};
