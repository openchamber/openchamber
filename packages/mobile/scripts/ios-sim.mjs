import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const BUNDLE_ID = 'com.openchamber.app';
const DEFAULT_DEVICE = 'iPhone 17 Pro';

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    env: process.env,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    if (options.capture && result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return result.stdout?.trim() ?? '';
};

const getBootedDevice = () => {
  const json = run('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'], { capture: true });
  const data = JSON.parse(json);
  for (const devices of Object.values(data.devices ?? {})) {
    const device = devices.find((item) => item.state === 'Booted');
    if (device) return device;
  }
  return null;
};

const bootDevice = (name = DEFAULT_DEVICE) => {
  const booted = getBootedDevice();
  if (booted) return booted.udid;

  const json = run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { capture: true });
  const data = JSON.parse(json);
  for (const devices of Object.values(data.devices ?? {})) {
    const match = devices.find((device) => device.name === name && device.isAvailable !== false);
    if (!match) continue;
    run('xcrun', ['simctl', 'boot', match.udid]);
    return match.udid;
  }

  throw new Error(`No available simulator named "${name}" found.`);
};

const getBuiltAppPath = () => {
  const appPath = run('xcodebuild', [
    '-workspace', 'ios/App/App.xcworkspace',
    '-scheme', 'App',
    '-configuration', 'Debug',
    '-sdk', 'iphonesimulator',
    '-showBuildSettings',
  ], { capture: true })
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('TARGET_BUILD_DIR = '))
    ?.replace('TARGET_BUILD_DIR = ', '');

  if (!appPath) throw new Error('Unable to resolve iOS simulator build output directory.');
  const fullPath = path.join(appPath, 'App.app');
  if (!existsSync(fullPath)) throw new Error(`Built app not found at ${fullPath}. Run bun run build:ios:simulator first.`);
  return fullPath;
};

const command = process.argv[2];

switch (command) {
  case 'boot': {
    const udid = bootDevice(process.argv.slice(3).join(' ') || DEFAULT_DEVICE);
    console.log(udid);
    break;
  }
  case 'install': {
    const udid = bootDevice();
    run('xcrun', ['simctl', 'install', udid, getBuiltAppPath()]);
    break;
  }
  case 'launch': {
    const udid = bootDevice();
    run('xcrun', ['simctl', 'launch', udid, BUNDLE_ID]);
    break;
  }
  case 'run': {
    const udid = bootDevice();
    run('xcrun', ['simctl', 'install', udid, getBuiltAppPath()]);
    run('xcrun', ['simctl', 'launch', udid, BUNDLE_ID]);
    break;
  }
  default:
    console.error('Usage: node scripts/ios-sim.mjs <boot|install|launch|run> [device name]');
    process.exit(1);
}
