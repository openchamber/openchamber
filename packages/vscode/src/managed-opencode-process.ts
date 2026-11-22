import { StringDecoder } from 'node:string_decoder';
import { spawnOwnedProcess } from './owned-process';
import { registerManagedProcess, unregisterManagedProcess } from './opencodeProcessRegistry';

export function spawnManagedOpenCodeProcess(
  binary: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; port: number; timeoutMs: number; signal: AbortSignal; sourceBinary: string; appBundleHint: string; stdinLeaseGraceMs?: number },
) {
  options.signal.throwIfAborted();
  const owned = spawnOwnedProcess(binary, args, { cwd: options.cwd, env: options.env, stdinLeaseGraceMs: options.stdinLeaseGraceMs });
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
    // Decode per stream through StringDecoder: a multi-byte UTF-8 character
    // split across pipe chunks must survive intact in the line buffer and in
    // the captured output startupError quotes (per-chunk chunk.toString()
    // silently corrupts the split character to U+FFFD).
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let decodersFlushed = false;
    const captureText = (text: string) => { output = (output + text).slice(-32 * 1024); };
    const capture = (chunk: Buffer) => captureText(stderrDecoder.write(chunk));
    const flushDecoders = () => {
      if (decodersFlushed) return;
      decodersFlushed = true;
      captureText(stderrDecoder.end());
      const tail = stdoutDecoder.end();
      captureText(tail);
      stdout += tail;
    };
    const startupError = (message: string) => new Error(`${message} Binary used: ${options.sourceBinary}.${options.appBundleHint} Output: ${output.trim() || '(none)'}`);
    const finish = (error?: Error) => {
      if (settled) return;
      flushDecoders();
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
      const text = stdoutDecoder.write(chunk);
      captureText(text);
      stdout += text;
      const lines = stdout.split('\n');
      stdout = (lines.pop() ?? '').slice(-32 * 1024);
      for (const line of lines) {
        // OpenCode 2.x prints `server listening on http://host:port`; 1.x
        // prefixed the same line with `opencode `. `serve --stdio` prints
        // `{"url":"http://host:port"}` instead. Anything else is noise.
        const match = line.match(/(?:^|\s)server listening on\s+(https?:\/\/[^\s]+)/)
          ?? line.match(/^\s*\{"url":"(https?:\/\/[^"\s]+)"\}\s*$/);
        if (!match) continue;
        url = match[1];
        finish();
        return;
      }
    };
    const timer = setTimeout(() => { flushDecoders(); finish(startupError(`Timeout waiting for server to start after ${options.timeoutMs}ms.`)); }, options.timeoutMs);
    owned.child.stdout.on('data', onStdout);
    owned.child.stderr.on('data', capture);
    void owned.closed.then((exit) => { flushDecoders(); finish(exit.error ?? startupError(`OpenCode process exited before serving with code ${exit.code}, signal ${exit.signal}.`)); });
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) onAbort();
  }).catch(async (error) => {
    await close();
    throw error;
  });
  return { get url() { return url; }, ready, close };
}
