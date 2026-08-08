import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, env: process.env, encoding: 'utf8', stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
};
const platform = process.argv[2];
if (platform === 'ios') {
  run('node', ['scripts/ios-sim.mjs', 'run']);
} else if (platform === 'android') {
  run('node', ['scripts/android-device.mjs', 'run']);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = spawnSync('adb', ['shell', 'pidof', 'com.openchamber.app'], { cwd: root, env: process.env, encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) break;
    if (attempt === 9) throw new Error('Android app did not remain running after launch');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
} else {
  console.error('Usage: node scripts/native-smoke.mjs <ios|android>');
  process.exit(1);
}
console.log(JSON.stringify({ platform, status: 'launched', bundleID: 'com.openchamber.app' }));
