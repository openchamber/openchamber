import type { spawn as nodeSpawn } from 'node:child_process';

const TARGET_ENV = 'OPENCHAMBER_SHELL_OPEN_TARGET';

const runPowerShellOnTarget = (spawn: typeof nodeSpawn, command: string, target: string) => new Promise<void>((resolve, reject) => {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, [TARGET_ENV]: target },
  });
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(`Explorer launch failed with code ${code ?? 'unknown'}`));
  });
});

export const openWindowsFolder = (spawn: typeof nodeSpawn, folderPath: string) =>
  runPowerShellOnTarget(spawn, `Start-Process -FilePath $env:${TARGET_ENV}`, folderPath);

export const selectInWindowsExplorer = (spawn: typeof nodeSpawn, filePath: string) =>
  runPowerShellOnTarget(spawn, `Start-Process -FilePath explorer.exe -ArgumentList ('/select,' + $env:${TARGET_ENV})`, filePath);
