// Install / launch the debug APK on a connected Android device via adb.
//
// Mirrors scripts/ios-sim.mjs for the iOS simulator. Run through with-mobile-env.mjs so adb
// (ANDROID_HOME/platform-tools) and the JDK are on PATH. Build the APK first with
// `bun run build:android:debug`; `run` installs + launches it.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const APK_PATH = join(mobileRoot, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const APP_ID = 'com.openchamber.app';
const LAUNCH_ACTIVITY = `${APP_ID}/.MainActivity`;

const adb = (args, { capture = false, allowFail = false } = {}) => {
  const result = spawnSync('adb', args, { stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (!allowFail && result.status !== 0) {
    throw new Error(`adb ${args.join(' ')} exited with ${result.status ?? result.signal}`);
  }
  return result;
};

const connectedDevices = () => {
  const output = adb(['devices'], { capture: true, allowFail: true }).stdout || '';
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('\tdevice'))
    .map((line) => line.split('\t')[0]);
};

const requireDevice = () => {
  const devices = connectedDevices();
  if (devices.length === 0) {
    console.error(
      'No authorized Android device found. Enable Developer options + USB debugging on the device, ' +
        'connect it, and accept the "Allow USB debugging" prompt. Check with: bun run android:devices',
    );
    process.exit(1);
  }
  return devices;
};

const requireApk = () => {
  if (!existsSync(APK_PATH)) {
    throw new Error(`Debug APK not found at ${APK_PATH}. Build it first: bun run build:android:debug`);
  }
};

const install = () => {
  requireDevice();
  requireApk();
  adb(['install', '-r', APK_PATH]);
};

const launch = () => {
  requireDevice();
  adb(['shell', 'am', 'start', '-n', LAUNCH_ACTIVITY]);
};

const command = process.argv[2];
switch (command) {
  case 'devices':
    adb(['devices', '-l']);
    break;
  case 'install':
    install();
    break;
  case 'launch':
    launch();
    break;
  case 'run':
    install();
    launch();
    break;
  case 'logcat': {
    requireDevice();
    const pid = (adb(['shell', 'pidof', APP_ID], { capture: true, allowFail: true }).stdout || '').trim().split(/\s+/)[0];
    if (pid) {
      adb(['logcat', `--pid=${pid}`]);
    } else {
      console.warn(`[android] ${APP_ID} is not running; streaming Capacitor/Chromium logs. Launch the app to see its logs.`);
      adb(['logcat', '-s', 'Capacitor:V', 'Capacitor/Console:V', 'chromium:V']);
    }
    break;
  }
  default:
    console.error('Usage: node scripts/android-device.mjs <devices|install|launch|run|logcat>');
    process.exit(1);
}
