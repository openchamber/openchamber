import { spawn } from 'node:child_process';

const keyPath = process.env.OPENCHAMBER_GIT_SSH_KEY;
if (!keyPath || /[\0\r\n]/.test(keyPath)) process.exit(1);

const child = spawn('ssh', [
  '-F', 'none',
  '-o', 'IdentityFile=none',
  '-i', keyPath,
  '-o', 'IdentitiesOnly=yes',
  '-o', 'IdentityAgent=none',
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=yes',
  ...process.argv.slice(2),
], {
  env: process.env,
  shell: false,
  windowsHide: true,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try { child.kill(signal); } catch {}
  });
}
child.once('error', () => process.exit(1));
child.once('close', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  }
  else process.exit(Number.isInteger(code) ? code : 1);
});
