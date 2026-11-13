import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isPlainObject, isString } from '../../shared/guards.js';
import { MAX_FRAME_BYTES, ProtectedMcpError } from './contract.js';
import { createLineReader } from './mcp-session.js';
import { ensurePrivateDirectory, writePrivateFile } from './store.js';

const STDERR_TAIL_BYTES = 64 * 1024;
const STOP_GRACE_MS = 2000;
const KILL_GRACE_MS = 5000;

const insideDirectory = (directory, relative) => {
  const target = path.resolve(directory, relative);
  if (target !== directory && !target.startsWith(`${directory}${path.sep}`)) throw new ProtectedMcpError('invalid_state_path', { status: 500 });
  return target;
};

/** Replaces every credential value in worker output before anyone can read it. */
function redactSecrets(text, secrets) {
  let result = text;
  for (const value of Object.values(secrets)) {
    if (isString(value) && value.length >= 4) result = result.split(value).join('[redacted]');
  }
  return result;
}

/**
 * Starts an approved stdio MCP server as the service identity. The executable
 * must pass the integrity check, the environment is built from nothing, and
 * secrets travel only in the environment or in files in the worker's private
 * directory.
 */
export async function startStdioUpstream({ definition, credentials, store, resolveExecutable, checkArgument = async () => {}, workerPath, onStderr = () => {}, log = () => {} }) {
  const executable = await resolveExecutable(definition.stdio.command);
  // An interpreter runs the script it is given: a path argument gets the executable's check.
  for (const argument of definition.stdio.args) {
    if (isString(argument) && path.isAbsolute(argument)) await checkArgument(argument);
  }
  const directory = await store.connectionDirectory(definition.id);
  const home = path.join(directory, 'home');
  const temporary = path.join(directory, 'tmp');
  const secretsRoot = path.join(directory, 'secrets');
  await Promise.all([ensurePrivateDirectory(home), ensurePrivateDirectory(temporary), ensurePrivateDirectory(secretsRoot)]);
  // One directory per session: another session of the same connection starting
  // or ending never touches the files this worker reads.
  const secretDirectory = await fs.mkdtemp(path.join(secretsRoot, 'session-'));
  const discardSecrets = () => fs.rm(secretDirectory, { recursive: true, force: true }).catch(() => {});

  const secrets = credentials?.secrets ?? {};
  let child;
  try {
    const env = { PATH: workerPath, HOME: home, TMPDIR: temporary, LANG: 'C.UTF-8' };
    for (const [name, value] of Object.entries(definition.stdio.env)) {
      if (isString(value)) env[name] = value;
      else if (isString(value.secret)) env[name] = secrets[value.secret];
      else if (isString(value.secretFile)) {
        const content = secrets[value.secretFile];
        if (!isString(content)) throw new ProtectedMcpError('secret_missing', { status: 500, message: `secret_missing: ${name}` });
        const file = path.join(secretDirectory, value.secretFile);
        await writePrivateFile(file, content);
        env[name] = file;
      } else env[name] = insideDirectory(directory, value.state);
    }
    for (const [name, value] of Object.entries(env)) {
      if (!isString(value)) throw new ProtectedMcpError('secret_missing', { status: 500, message: `secret_missing: ${name}` });
    }
    const args = definition.stdio.args.map((argument) => (isPlainObject(argument) ? insideDirectory(directory, argument.state) : argument));
    child = spawn(executable, args, { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (error) => reject(new ProtectedMcpError('runtime_unavailable', { status: 500, message: error.code ?? 'spawn_failed' })));
    });
  } catch (error) {
    // No worker will read them: the files go before the refusal does.
    await discardSecrets();
    throw error;
  }
  let onMessage = () => {};
  let onClose = () => {};
  let exited = false;
  let stderrTail = '';

  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  };
  child.stdout.on('data', createLineReader({
    onValue: (value) => onMessage(value),
    onInvalid: () => log('worker_invalid_output', { connection: definition.id }),
    onOverflow: () => log('worker_frame_too_large', { connection: definition.id }),
  }));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrTail = redactSecrets(`${stderrTail}${chunk}`, secrets).slice(-STDERR_TAIL_BYTES);
    onStderr(stderrTail);
  });
  child.stdin.on('error', () => {});
  child.once('exit', () => {
    exited = true;
    discardSecrets();
    onClose();
  });

  return {
    pid: child.pid,
    send(message) {
      if (exited) return;
      if (child.stdin.writableLength > MAX_FRAME_BYTES * 2) {
        killGroup('SIGKILL');
        return;
      }
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(callback) { onMessage = callback; },
    onClose(callback) { onClose = callback; },
    close() {
      if (exited) return;
      child.stdin.end();
      setTimeout(() => {
        if (exited) return;
        killGroup('SIGTERM');
        setTimeout(() => { if (!exited) killGroup('SIGKILL'); }, KILL_GRACE_MS).unref();
      }, STOP_GRACE_MS).unref();
    },
  };
}
