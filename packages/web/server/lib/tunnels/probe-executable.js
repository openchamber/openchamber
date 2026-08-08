import { execFile } from 'node:child_process';

/**
 * Runs a short command and reports what it printed, without stopping the server while it
 * runs. `spawnSync` blocks the event loop for the whole duration of the child process,
 * so a dependency probe measured at ~370ms on Windows stalled every other request for
 * that long — including the sibling requests the same page issues in parallel, which
 * made a page that looks like it fetches concurrently behave as if it were serial.
 */
export function probeExecutable(command, args, { env, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = execFile(command, args, { encoding: 'utf8', windowsHide: true, env, timeout: timeoutMs }, (error, stdout, stderr) => {
        finish({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      });
      child.on('error', () => finish({ status: 1, stdout: '', stderr: '' }));
    } catch {
      finish({ status: 1, stdout: '', stderr: '' });
    }
  });
}

/**
 * Whether a dependency is installed, and at what version, changes when someone installs
 * or removes it — not between two requests of the same page load. Each answer costs a
 * process start (measured at 189ms for cloudflared and 674ms for ngrok on Windows), and
 * a page that asks on every visit pays it every time, so answers are held briefly.
 */
const DEPENDENCY_TTL_MS = 60_000;
const dependencyAnswers = new Map();

export async function cachedDependencyProbe(key, resolve, { force = false, now = Date.now } = {}) {
  const cached = dependencyAnswers.get(key);
  if (!force && cached && cached.expiresAt > now()) return cached.value;
  const value = await resolve();
  // Only a positive answer is held: someone who has just installed the dependency should
  // see that on the next look, rather than waiting out a cache of the old bad news.
  if (value?.available === true) dependencyAnswers.set(key, { value, expiresAt: now() + DEPENDENCY_TTL_MS });
  else dependencyAnswers.delete(key);
  return value;
}

export function resetDependencyProbeCache() {
  dependencyAnswers.clear();
}
