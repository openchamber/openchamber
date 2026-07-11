import { spawn } from 'node:child_process';

const command = process.argv.slice(2).join(' ');

if (!command) {
  console.error('Usage: node scripts/with-mobile-env.mjs <command>');
  process.exit(1);
}

const javaHome = process.env.JAVA_HOME || '/opt/homebrew/opt/openjdk@21';
const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '/opt/homebrew/share/android-commandlinetools';

const child = spawn(command, {
  env: {
    ...process.env,
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
