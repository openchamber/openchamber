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
// No product flavors are defined in the Gradle build, so `assembleDebug`
// produces the flavorless output below (the path HANDOFF.md documents).
const APK_PATH = join(mobileRoot, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const APP_ID = 'today.developing.openchamber';
// MainActivity lives in the native namespace (build.gradle `namespace`), not the
// application id — the two diverged when the application id was unified, and
// `am start -n <applicationId>/.MainActivity` expands the class against the
// application id, naming a class that does not exist.
const ACTIVITY_CLASS = 'com.openchamber.app.MainActivity';
const LAUNCH_ACTIVITY = `${APP_ID}/${ACTIVITY_CLASS}`;

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

// Android reports the reason in the failure code. The two that mean "this APK cannot
// replace the installed app" need the installed copy removed, and the phone's Package
// Installer shows them only as "App not installed as package appears to be invalid".
const INSTALL_FAILURE_HINTS = {
  INSTALL_FAILED_UPDATE_INCOMPATIBLE:
    'The installed app is signed with a different key. Its data goes with it on uninstall. Remove it, then install again: adb uninstall today.developing.openchamber',
  INSTALL_FAILED_VERSION_DOWNGRADE:
    'The installed app has a higher versionCode than this build. Remove it, then install again: adb uninstall today.developing.openchamber',
  INSTALL_PARSE_FAILED_NO_CERTIFICATES:
    'The APK is unsigned. Rebuild it; signing is set by the OPENCHAMBER_ANDROID_* environment.',
};

const install = () => {
  requireDevice();
  requireApk();
  const result = adb(['install', '-r', APK_PATH], { capture: true, allowFail: true });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status === 0) {
    process.stdout.write(output);
    return;
  }
  process.stderr.write(output);
  const code = Object.keys(INSTALL_FAILURE_HINTS).find((name) => output.includes(name));
  if (code) console.error(`[android] ${INSTALL_FAILURE_HINTS[code]}`);
  throw new Error(`adb install exited with ${result.status ?? result.signal}`);
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
