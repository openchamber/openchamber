import { execFile } from 'node:child_process';

// The resolved launch target can be a native CLI or a runtime plus script.
// No request-supplied command, version, or installer method reaches this process.
// A stalled upgrade must not wedge the upgrade route: POST
// /api/opencode/upgrade clears its in-flight flag only when this promise
// settles, so an unbounded child would block every later attempt until a
// server restart (#866). The default gives a real package-manager upgrade
// generous room; on expiry execFile kills the child with SIGKILL and the
// callback below rejects with the usual generic message.
const DEFAULT_UPGRADE_TIMEOUT_MS = 10 * 60_000;

export const runOpenCodeCliUpgrade = (launch, options = {}) => new Promise((resolve, reject) => {
  const child = execFile(launch.binary, [...launch.args, 'upgrade'], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    timeout: options.timeoutMs ?? DEFAULT_UPGRADE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  }, (error) => {
    // Installer output can contain registry credentials. Do not log or return it.
    if (error) reject(new Error('OpenCode CLI upgrade failed. Run opencode upgrade in a terminal for details.'));
    else resolve();
  });
  // Package managers must receive EOF instead of waiting for interactive input.
  child.stdin?.end();
});
