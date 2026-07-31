const fs = require('node:fs');
const path = require('node:path');

module.exports = (context) => {
  const resourcesPath = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const betterSqliteDir = path.dirname(require.resolve('better-sqlite3/package.json'));
  const betterSqliteBinary = path.join(betterSqliteDir, 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(betterSqliteBinary)) {
    throw new Error(`Missing rebuilt better-sqlite3 binary at ${betterSqliteBinary}`);
  }
  const packagedBetterSqliteBinary = path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  fs.mkdirSync(path.dirname(packagedBetterSqliteBinary), { recursive: true });
  fs.copyFileSync(betterSqliteBinary, packagedBetterSqliteBinary);

  if (context.electronPlatformName !== 'darwin') return;

  const sourceAssetsPath = path.join(__dirname, '..', 'resources', 'icons', 'Assets.car');

  if (!fs.existsSync(sourceAssetsPath)) {
    throw new Error(`Missing compiled app icon asset catalog at ${sourceAssetsPath}`);
  }

  fs.copyFileSync(sourceAssetsPath, path.join(resourcesPath, 'Assets.car'));
};
