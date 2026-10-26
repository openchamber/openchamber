// How OpenChamber asks its managed OpenCode to stop on Windows.
//
// Windows has no SIGTERM: `child.kill()` and `taskkill /F` end OpenCode at
// once, before it records how its running turns ended. A chat that was waiting
// on a question then reopens as still working, and nothing can stop it (#4988).
// On POSIX the SIGTERM sent first lets OpenCode close those turns.
//
// `opencode serve --stdio` treats EOF on its stdin as the end of its ownership
// lease and shuts down the same way: running turns end as cancelled and its MCP
// servers are stopped with their process trees. OpenCode's own CLI starts its
// server this way. Teardown closes stdin first and force-kills the tree only if
// OpenCode is still running after the grace period.

const OPENCODE_STDIN_SHUTDOWN_GRACE_MS = 5000;
const FORCE_KILL_CLOSE_WAIT_MS = 3000;

export const hasChildProcessExited = (child) => !child
  || (child.exitCode !== null && child.exitCode !== undefined)
  || (child.signalCode !== null && child.signalCode !== undefined);

export const waitForChildProcessClose = (child, timeoutMs) => new Promise((resolve) => {
  if (!child || hasChildProcessExited(child)) {
    resolve(true);
    return;
  }

  let done = false;
  const finish = (closed) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    child.off('close', onClose);
    child.off('error', onError);
    resolve(closed);
  };

  const onClose = () => finish(true);
  const onError = () => finish(hasChildProcessExited(child));
  const timer = setTimeout(() => finish(hasChildProcessExited(child)), timeoutMs);

  child.once('close', onClose);
  child.once('error', onError);
});

/**
 * Close the stdin lease of an `opencode serve --stdio` child, wait up to
 * `graceMs` for it to exit, then call `forceKillTree(pid)`. Resolves to
 * `'exited'` when OpenCode shut down on its own, `'killed'` otherwise.
 */
export const stopOpenCodeByClosingStdin = async (child, {
  forceKillTree,
  graceMs = OPENCODE_STDIN_SHUTDOWN_GRACE_MS,
}) => {
  if (hasChildProcessExited(child)) return 'exited';

  const stdin = child.stdin;
  if (stdin && !stdin.destroyed) {
    try {
      stdin.end();
    } catch {
    }
    if (await waitForChildProcessClose(child, graceMs)) return 'exited';
  }

  // The tree must be killed while its root still exists, otherwise taskkill
  // /T cannot find the descendants.
  forceKillTree(child.pid);
  await waitForChildProcessClose(child, FORCE_KILL_CLOSE_WAIT_MS);
  return 'killed';
};
