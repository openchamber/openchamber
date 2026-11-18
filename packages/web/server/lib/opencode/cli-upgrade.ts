import { execFile } from 'node:child_process';

export const runOpenCodeCliUpgrade = (
  launch: { binary: string; args: readonly string[] },
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) => new Promise<void>((resolve, reject) => {
  const child = execFile(launch.binary, [...launch.args, 'upgrade'], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  }, (error) => {
    if (error) reject(new Error('OpenCode CLI upgrade failed. Run opencode upgrade in a terminal for details.'));
    else resolve();
  });
  child.stdin?.end();
});
