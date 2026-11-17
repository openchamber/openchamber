// external: https://developers.google.com/ml-kit/known-issues ML Kit does not support Apple-Silicon simulators.

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

run('bun', ['run', 'build']);
run('cap', ['copy', 'ios']);

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
  if (strippedPodfile !== originalPodfile) {
    writeFileSync(podfilePath, originalPodfile);
    run('pod', ['install'], iosAppDir);
  }
}

console.log('[ios-sim-build] Simulator build complete. Run `bun run sim:run` to install + launch.');
