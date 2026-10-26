import { spawn, spawnSync } from 'node:child_process';

const command = process.argv.slice(2).join(' ');

if (!command) {
  console.error('Usage: node scripts/with-mobile-env.mjs <command>');
  process.exit(1);
}

// Respect an explicit DEVELOPER_DIR, then fall back to whatever the user selected via
// `xcode-select` (so an Xcode beta / non-default install is honoured). Hardcoding
// /Applications/Xcode.app overrode `xcode-select` and forced builds onto the wrong Xcode,
// whose simulator runtimes may not match — xcodebuild then can't find the chosen simulator.
const selectedDeveloperDir = () => {
  try {
    const result = spawnSync('xcode-select', ['-p'], { encoding: 'utf8' });
    const path = result.status === 0 ? result.stdout.trim() : '';
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
};

const developerDir =
  process.env.DEVELOPER_DIR || selectedDeveloperDir() || '/Applications/Xcode.app/Contents/Developer';
const javaHome = process.env.JAVA_HOME || '/opt/homebrew/opt/openjdk@21';
const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '/opt/homebrew/share/android-commandlinetools';

const child = spawn(command, {
  env: {
    ...process.env,
    DEVELOPER_DIR: developerDir,
    JAVA_HOME: javaHome,
    ANDROID_HOME: androidHome,
    ANDROID_SDK_ROOT: androidHome,
    PATH: `${javaHome}/bin:${androidHome}/platform-tools:${process.env.PATH || ''}`,
  },
  shell: true,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
