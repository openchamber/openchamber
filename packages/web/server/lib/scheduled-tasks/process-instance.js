import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const processExists = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
};

let bootIdentity;
let ownIdentity;

const inspectProcess = async (pid, dependencies) => {
  const {
    platform = process.platform, env = process.env, readFileImpl = readFile,
    execFileImpl = execute, exists = processExists,
  } = dependencies ?? {};
  if (!exists(pid)) return null;
  const options = { timeout: 2_000, maxBuffer: 64 * 1024, windowsHide: true, env: { ...env, LC_ALL: 'C', TZ: 'UTC' } };
  const readBootIdentity = async () => {
    const value = platform === 'linux'
      ? await readFileImpl('/proc/sys/kernel/random/boot_id', 'utf8')
      : (await execFileImpl('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], options)).stdout;
    const id = value.trim().toLowerCase();
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid OS boot identity');
    return id;
  };
  const boot = () => {
    if (dependencies) return readBootIdentity();
    bootIdentity ??= readBootIdentity().catch((error) => { bootIdentity = undefined; throw error; });
    return bootIdentity;
  };
  try {
    if (platform === 'linux') {
      const raw = await readFileImpl(`/proc/${pid}/stat`, 'utf8');
      // comm can contain spaces and parentheses. Field 22 follows its final ')'.
      const start = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
      if (!/^\d+$/.test(start ?? '')) throw new Error('Invalid Linux process start time');
      return `linux:${await boot()}:${start}`;
    }
    if (platform === 'darwin') {
      const { stdout } = await execFileImpl('/bin/ps', ['-p', String(pid), '-o', 'lstart='], options);
      const start = stdout.trim().replace(/\s+/g, ' ');
      if (!/^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(start)) {
        throw new Error('Invalid macOS process start time');
      }
      return `darwin:${await boot()}:${start}`;
    }
    if (platform === 'win32') {
      const binary = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script = `$ErrorActionPreference = 'Stop'; $p = [System.Diagnostics.Process]::GetProcessById(${pid}); try { $p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) } finally { $p.Dispose() }`;
      const { stdout } = await execFileImpl(binary, [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
      ], options);
      const start = stdout.trim();
      if (!/^\d+$/.test(start)) throw new Error('Invalid Windows process start time');
      return `win32:${start}`;
    }
    throw new Error(`Process instance checks are unavailable on ${platform}`);
  } catch (error) {
    // A process can exit between its existence check and the native read.
    if (!exists(pid)) return null;
    throw error;
  }
};

/** Null means the process is gone; an unreadable identity throws. */
export const readProcessInstance = (pid, dependencies) => {
  if (pid === 0) return Promise.resolve(null);
  if (!Number.isSafeInteger(pid) || pid < 0) throw new Error('Invalid process id');
  // This process and boot cannot change during this module's lifetime. Other
  // PIDs are always read afresh because they can be reused.
  if (pid === process.pid && !dependencies) {
    ownIdentity ??= inspectProcess(pid).catch((error) => { ownIdentity = undefined; throw error; });
    return ownIdentity;
  }
  return inspectProcess(pid, dependencies);
};
