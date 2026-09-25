import { spawnOwnedProcess } from './owned-process';
import { registerManagedProcess, unregisterManagedProcess } from './opencodeProcessRegistry';

export function spawnManagedOpenCodeProcess(
  binary: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; port: number; timeoutMs: number; signal: AbortSignal; sourceBinary: string; appBundleHint: string },
) {
  options.signal.throwIfAborted();
  const owned = spawnOwnedProcess(binary, args, { cwd: options.cwd, env: options.env });
  const registration = registerManagedProcess({
    pid: owned.child.pid, ownerPid: process.pid, port: options.port, binary: options.sourceBinary, runtime: 'vscode',
  });
  let closing: Promise<void> | null = null;
  const close = () => {
    if (!closing) closing = (async () => {
      await registration;
      await owned.terminate();
      await unregisterManagedProcess(owned.child.pid);
    })();
    return closing;
  };
  let url: string | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    let stdout = '';
    let output = '';
    let settled = false;
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-32 * 1024); };
    const startupError = (message: string) => new Error(`${message} Binary used: ${options.sourceBinary}.${options.appBundleHint} Output: ${output.trim() || '(none)'}`);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      owned.child.stdout.off('data', onStdout);
      owned.child.stderr.off('data', capture);
      // Continue draining after readiness without retaining server output.
      owned.child.stdout.resume();
      owned.child.stderr.resume();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new Error('OpenCode startup cancelled'));
    const onStdout = (chunk: Buffer) => {
      capture(chunk);
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = (lines.pop() ?? '').slice(-32 * 1024);
      for (const line of lines) {
        // OpenCode 2.x prints `server listening on http://host:port`; 1.x
        // prefixed the same line with `opencode `. Anything else is noise.
        const match = line.match(/(?:^|\s)server listening on\s+(https?:\/\/[^\s]+)/);
        if (!match) continue;
        url = match[1];
        finish();
        return;
      }
    };
    const timer = setTimeout(() => finish(startupError(`Timeout waiting for server to start after ${options.timeoutMs}ms.`)), options.timeoutMs);
    owned.child.stdout.on('data', onStdout);
    owned.child.stderr.on('data', capture);
    void owned.closed.then((exit) => finish(exit.error ?? startupError(`OpenCode process exited before serving with code ${exit.code}, signal ${exit.signal}.`)));
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) onAbort();
  }).catch(async (error) => {
    await close();
    throw error;
  });
  return { get url() { return url; }, ready, close };
}
