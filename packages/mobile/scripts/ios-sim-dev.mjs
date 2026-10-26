// One-command simulator dev loop: build the simulator app, install + launch it,
// start the serve-sim browser stream, and print the preview URL.
// The process then stays in the foreground so Ctrl+C stops the stream helpers.
//
// Pass --no-build to skip the (slow) web + xcodebuild step and just relaunch the
// previously built app with a fresh stream.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// serve-sim resolves from the package bin dir; plain `serve-sim` is not on PATH
// when this script is invoked outside `bun run`.
const env = {
  ...process.env,
  PATH: `${join(mobileRoot, 'node_modules', '.bin')}:${process.env.PATH || ''}`,
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: mobileRoot,
    env,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.status !== 0) {
    console.error(`[ios-sim-dev] ${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`);
    process.exit(result.status ?? 1);
  }
  return result.stdout?.trim() ?? '';
};

if (!process.argv.includes('--no-build')) {
  run('node', ['scripts/ios-sim-build.mjs']);
}

run('node', ['scripts/ios-sim.mjs', 'run']);

const serveOutput = run('serve-sim', ['--detach', '-q'], { capture: true });
let url;
try {
  url = JSON.parse(serveOutput).url;
} catch {
  // fall through to the guard below
}
if (!url) {
  console.error(`[ios-sim-dev] Unexpected serve-sim output: ${serveOutput}`);
  process.exit(1);
}

console.log(`[ios-sim-dev] Stream ready at ${url}`);
console.log('[ios-sim-dev] Press Ctrl+C to stop the stream (the simulator stays running).');

const stop = () => {
  spawnSync('serve-sim', ['--kill'], { cwd: mobileRoot, env, stdio: 'inherit' });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// Keep the foreground process alive until a signal arrives.
setInterval(() => {}, 1 << 30);
