// Builds the iOS app for the Apple-Silicon simulator.
//
// Why this is special: the barcode scanner (`@capacitor-mlkit/barcode-scanning` →
// GoogleMLKit) ships only device-arm64 + simulator-x86_64 slices — there is NO
// arm64-simulator slice. CocoaPods therefore adds `EXCLUDED_ARCHS[sdk=iphonesimulator*] =
// arm64`, so a normal build produces an x86_64-only binary that can't install on an
// arm64-only iOS 26+ simulator ("does not contain code for ... arm64").
//
// QR scanning needs a camera, which the simulator doesn't have, so dropping the scanner for
// simulator builds loses nothing: this script temporarily removes the MLKit pod, builds an
// arm64 simulator binary, then restores the Podfile + Pods so device/TestFlight builds keep
// the scanner. The JS side already degrades cleanly when the native plugin is absent
// (mobileQrScan: getScannerPlugin() → null → isQrScanSupported() false).

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const iosAppDir = join(mobileRoot, 'ios', 'App');
const podfilePath = join(iosAppDir, 'Podfile');

const run = (command, args, cwd = mobileRoot) => {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd, env: process.env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`);
  }
};

// 1. Build the web bundle and copy it into the iOS project (no pod regen — `copy`, not `sync`).
run('bun', ['run', 'build']);
run('cap', ['copy', 'ios']);

// 2. Strip the MLKit barcode-scanning pod, then reinstall pods without it.
const originalPodfile = readFileSync(podfilePath, 'utf8');
const strippedPodfile = originalPodfile
  .split('\n')
  .filter((line) => !line.includes('CapacitorMlkitBarcodeScanning'))
  .join('\n');

if (strippedPodfile === originalPodfile) {
  console.warn('[ios-sim-build] CapacitorMlkitBarcodeScanning not found in Podfile — building as-is.');
}

try {
  writeFileSync(podfilePath, strippedPodfile);
  run('pod', ['install'], iosAppDir);

  // 3. Build for the simulator. With MLKit gone the arm64 simulator slice builds cleanly.
  run('xcodebuild', [
    '-workspace', 'ios/App/App.xcworkspace',
    '-scheme', 'App',
    '-configuration', 'Debug',
    '-sdk', 'iphonesimulator',
    '-destination', 'generic/platform=iOS Simulator',
    'CODE_SIGNING_ALLOWED=NO',
    'build',
  ]);
} finally {
  // 4. Always restore the Podfile + Pods so device/TestFlight builds keep the scanner. Pods/
  //    and Podfile.lock return to their original state (a no-op for git once this completes).
  if (strippedPodfile !== originalPodfile) {
    writeFileSync(podfilePath, originalPodfile);
    run('pod', ['install'], iosAppDir);
  }
}

console.log('[ios-sim-build] Simulator build complete. Run `bun run sim:run` to install + launch.');
