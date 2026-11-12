import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { SpaceError } from '../spaces/errors.js';
import { SPACE_CONNECT_COMMAND } from '../spaces/layout.js';
import { execArguments, exitCode, names } from './units.js';
import { showUnit } from './system.js';

export function createExecutor({ system, paths, state }) {
  const run = async (request, io) => {
    const record = await state.requireRecord(request.place, request.id);
    const target = request.target ?? 'space';
    const main = await showUnit(system, names(record.id)[target]);
    if (main.ActiveState !== 'active') throw new SpaceError('space_not_running', `Space ${record.id} is stopped`);
    if (target === 'space' && record.place === 'host') {
      const readOnly = String(main.ReadOnlyPaths).split(' ');
      if (![`${paths.spaceState}/${record.id}`, `${paths.privateState}/${record.id}`].every((parent) => readOnly.includes(parent))) {
        throw new SpaceError('space_verification_failed', 'Restart this space before exec: its state source parents are mutable');
      }
    }
    if (io.signal?.aborted) throw new SpaceError('command_aborted', 'The hostd client disconnected');
    const unit = `openchamber-exec-${record.id}-${randomBytes(6).toString('hex')}.service`;
    const marker = `hostd-started-${randomBytes(16).toString('hex')}`;
    // The fixed shell acknowledges that the transient unit exists before execing argv.
    // A disconnect that raced StartTransientUnit is stopped again at that acknowledgement.
    const argv = ['/bin/sh', '-c', 'printf "%s\\n" "$1" >&2; shift; exec /usr/bin/env -- "$@"', 'sh', marker, ...(request.argv ?? SPACE_CONNECT_COMMAND)];
    const args = execArguments({ record, paths, target, unit, argv });
    const child = system.spawn('/usr/bin/systemd-run', args);
    let failure = null;
    let outputBytes = 0;
    let ended = false;
    const stop = (error, retry = false) => {
      if (failure && !retry) return;
      failure ??= error;
      // Stop the whole transient cgroup, including descendants that kept the pipes open.
      void system.run('/usr/bin/systemctl', ['stop', unit]).catch(() => {});
    };
    const abort = () => stop(new SpaceError('command_aborted', 'The hostd client disconnected'));
    io.signal?.addEventListener('abort', abort, { once: true });
    const timeout = request.op === 'attach' ? null : setTimeout(() => stop(new SpaceError('command_timeout', `Command exceeded ${request.timeoutMs} ms`)), request.timeoutMs);
    const capture = (write) => async (chunk) => {
      outputBytes += chunk.length;
      if (request.op !== 'attach' && !request.keepTail && outputBytes > request.maxOutputBytes) {
        stop(new SpaceError('command_output_too_large', `Command exceeded ${request.maxOutputBytes} output bytes`));
        return;
      }
      if (!failure) await write(chunk);
    };
    const pump = async (stream, write) => { for await (const chunk of stream) await write(chunk); };
    child.stdin.on('error', () => {});
    const input = (async () => {
      try {
        for await (const chunk of io.stdin) {
          if (ended) break;
          if (!child.stdin.write(chunk)) await once(child.stdin, 'drain');
        }
        child.stdin.end();
      } catch (error) { if (!ended) stop(error); }
    })();
    void input;
    let prelude = Buffer.alloc(0);
    let identified = false;
    const writeError = capture(io.stderr);
    const stderr = async (chunk) => {
      if (identified) { await writeError(chunk); return; }
      prelude = Buffer.concat([prelude, chunk]);
      const expected = Buffer.from(`${marker}\n`);
      if (prelude.length < expected.length) return;
      identified = true;
      if (prelude.subarray(0, expected.length).equals(expected)) {
        if (failure) stop(failure, true);
        if (prelude.length > expected.length) await writeError(prelude.subarray(expected.length));
      } else await writeError(prelude);
      prelude = Buffer.alloc(0);
    };
    try {
      const close = once(child, 'close');
      const [, , [runnerCode]] = await Promise.all([pump(child.stdout, capture(io.stdout)), pump(child.stderr, stderr), close]);
      if (prelude.length > 0 && !failure) await writeError(prelude);
      ended = true;
      if (failure) throw failure;
      const result = await showUnit(system, unit);
      // systemd 259 may GC a successful inactive transient unit immediately after --wait
      // releases its reference. The runner's successful wait remains authoritative for exit 0.
      return result.LoadState === 'not-found' && runnerCode === 0 ? 0 : exitCode(result);
    } finally {
      ended = true;
      if (timeout !== null) clearTimeout(timeout);
      io.signal?.removeEventListener('abort', abort);
      // Without --collect, the finished unit's exit properties are still available above.
      await system.run('/usr/bin/systemctl', ['reset-failed', unit]);
    }
  };
  const collect = async (request, stdin = '') => {
    const stdout = [];
    const stderr = [];
    const code = await run(request, { stdin: [Buffer.from(stdin)], stdout: async (chunk) => { stdout.push(chunk); }, stderr: async (chunk) => { stderr.push(chunk); } });
    return { code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
  };
  return { run, collect };
}
