import { spawn } from 'node:child_process';

import { SpaceError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Runs one executable with an argument array and resolves `{ code, stdout, stderr }`
 * for any exit code. The executable is spawned directly, never through a shell.
 *
 * Rejects with a SpaceError when the process cannot start (`command_spawn_failed`),
 * runs past `timeoutMs` (`command_timeout`), prints more than `maxOutputBytes`
 * (`command_output_too_large`), or dies from a signal (`command_killed`). The child
 * is killed in the first three cases.
 */
export function runCommand(file, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stdin = options.stdin ?? '';

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new SpaceError('command_spawn_failed', `Could not start ${file}: ${error.message}`, { errno: error.code ?? null }));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedBytes = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(new SpaceError('command_timeout', `${file} ${args[0] ?? ''} did not finish within ${timeoutMs} ms and was stopped`));
    }, timeoutMs);

    const capture = (chunks) => (chunk) => {
      capturedBytes += chunk.length;
      if (capturedBytes > maxOutputBytes) {
        fail(new SpaceError('command_output_too_large', `${file} ${args[0] ?? ''} printed more than ${maxOutputBytes} bytes and was stopped`));
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on('data', capture(stdoutChunks));
    child.stderr.on('data', capture(stderrChunks));

    child.on('error', (error) => {
      fail(new SpaceError('command_spawn_failed', `Could not start ${file}: ${error.message}`, { errno: error.code ?? null }));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === null) {
        reject(new SpaceError('command_killed', `${file} ${args[0] ?? ''} was stopped by signal ${signal}`));
        return;
      }
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });

    // A child that exits without reading its input closes the pipe first.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}
