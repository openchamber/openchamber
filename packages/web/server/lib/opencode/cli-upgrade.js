import { execFile } from 'node:child_process';

// The resolved launch target can be a native CLI or a runtime plus script.
// No request-supplied command, version, or installer method reaches this process.
export const runOpenCodeCliUpgrade = (launch, options = {}) => new Promise((resolve, reject) => {
  const child = execFile(launch.binary, [...launch.args, 'upgrade'], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  }, (error) => {
    // Installer output can contain registry credentials. Do not log or return it.
    if (error) reject(new Error('OpenCode CLI upgrade failed. Run opencode upgrade in a terminal for details.'));
    else resolve();
  });
  // Package managers must receive EOF instead of waiting for interactive input.
  child.stdin?.end();
});
