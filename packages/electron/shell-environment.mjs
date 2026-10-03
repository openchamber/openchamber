import { spawn } from 'node:child_process';
import path from 'node:path';

const executeShell = (shell, args, options) => new Promise((resolve, reject) => {
  const child = spawn(shell, args, { ...options, stdio: ['ignore', 'pipe', 'ignore'] });
  const chunks = [];
  let bytes = 0;
  let outputTooLarge = false;
  let processError;
  child.stdout.on('data', (chunk) => {
    if (outputTooLarge) return;
    bytes += chunk.length;
    // Match spawnSync's previous stdout limit without buffering shell stderr.
    if (bytes > 1024 * 1024) {
      outputTooLarge = true;
      chunks.length = 0;
      child.kill();
      return;
    }
    chunks.push(chunk);
  });
  child.once('error', (error) => { processError = error; });
  child.once('close', (code) => {
    if (code === 0 && !child.killed && !outputTooLarge && !processError) resolve({ stdout: Buffer.concat(chunks) });
    else reject(processError || new Error('Shell environment probe failed'));
  });
});

// Interactive rc files may print a banner, motd or other text to stdout before
// the shell runs the probe command. That text would otherwise fuse with the
// first `env -0` entry, so a marker line is echoed right before `env -0` and
// only what follows the last marker line is parsed.
const ENV_MARKER = '__OPENCHAMBER_ENV__';
const ENV_COMMAND = `echo ${ENV_MARKER}; env -0`;

const stripShellStartupOutput = (text) => {
  const markerLine = `${ENV_MARKER}\n`;
  const markerIndex = text.lastIndexOf(markerLine);
  return markerIndex === -1 ? text : text.slice(markerIndex + markerLine.length);
};

const parseShellEnv = (stdout) => {
  const env = {};
  for (const entry of stripShellStartupOutput(stdout.toString('utf8')).split('\0')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return Object.keys(env).length > 0 ? env : null;
};

// Concurrent startup callers must all await the same probe, including its
// fallback. Cache a failed probe too, so an unavailable shell is tried once.
export const createShellEnvironmentLoader = ({
  loadWindowsEnv,
  platform = process.platform,
  env = process.env,
  execute = executeShell,
  timeoutMs = 5_000,
  signal,
}) => {
  let pending;

  const probe = async (shell, mode) => {
    try {
      const { stdout } = await execute(shell, [mode, '-c', ENV_COMMAND], {
        timeout: timeoutMs,
        windowsHide: true,
        signal,
      });
      signal?.throwIfAborted();
      return parseShellEnv(stdout);
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  };

  const load = async () => {
    signal?.throwIfAborted();
    if (platform === 'win32') return loadWindowsEnv();
    const shell = env.SHELL || '/bin/sh';
    const name = path.basename(shell).toLowerCase();
    if (name === 'nu' || name === 'nu.exe') return null;
    return await probe(shell, '-il') || await probe(shell, '-l');
  };

  return () => {
    pending ??= load();
    return pending;
  };
};
