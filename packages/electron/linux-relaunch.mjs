import { spawn } from 'node:child_process';

const WAIT_THEN_EXEC = 'while kill -0 "$0" 2>/dev/null; do sleep 0.2; done; exec "$@"';

// external: https://man7.org/linux/man-pages/man2/PR_SET_NO_NEW_PRIVS.2const.html app.relaunch inherits no_new_privs and breaks later pkexec updates; a detached shell waits for exit without setting it.
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
