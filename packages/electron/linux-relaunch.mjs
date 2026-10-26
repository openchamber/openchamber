import { spawn } from 'node:child_process';

// Waits for the given pid to exit, then replaces itself with the app.
// `$0` is the pid; `$@` is the command line to start.
const WAIT_THEN_EXEC = 'while kill -0 "$0" 2>/dev/null; do sleep 0.2; done; exec "$@"';

/**
 * Starts the app again once this process has exited, without app.relaunch().
 *
 * Chromium launches app.relaunch()'s process with no_new_privs set, and the
 * flag is inherited by everything that process starts. pkexec then refuses
 * to run ("pkexec must be setuid root"), so an installed .deb or .rpm could
 * never update again after its first relaunch. A plain detached shell keeps
 * the privileges the app was started with. Waiting for the exit keeps the new
 * instance from handing itself to the old one through the single-instance lock.
 */
export const relaunchAfterExit = ({
  pid = process.pid,
  command = process.argv,
} = {}) => {
  const child = spawn('/bin/sh', ['-c', WAIT_THEN_EXEC, String(pid), ...command], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
};
