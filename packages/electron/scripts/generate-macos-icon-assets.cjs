const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const iconName = 'AppIcon';
const iconsDir = path.join(__dirname, '..', 'resources', 'icons');
const sourceIconPath = path.join(iconsDir, `${iconName}.icon`);
const outputAssetsPath = path.join(iconsDir, 'Assets.car');

const resolveActool = () => {
  try {
    return execFileSync('xcrun', ['--find', 'actool'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    const xcodeActool = '/Applications/Xcode.app/Contents/Developer/usr/bin/actool';
    if (fs.existsSync(xcodeActool)) return xcodeActool;
    throw new Error('Unable to find actool. Install Xcode or set DEVELOPER_DIR to a full Xcode installation.');
  }
};

if (!fs.existsSync(sourceIconPath)) {
  throw new Error(`Missing Icon Composer source at ${sourceIconPath}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-app-icon-'));
try {
  execFileSync(resolveActool(), [
    sourceIconPath,
    '--compile', tmpDir,
    '--app-icon', iconName,
    '--platform', 'macosx',
    '--target-device', 'mac',
    '--minimum-deployment-target', '13.0',
    '--output-partial-info-plist', path.join(tmpDir, 'partial.plist'),
  ], { stdio: 'inherit' });

  fs.copyFileSync(path.join(tmpDir, 'Assets.car'), outputAssetsPath);
  console.log(`Generated ${outputAssetsPath}`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
