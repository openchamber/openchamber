import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';

const execFileAsync = promisify(execFile);

interface ProcessStartOptions {
  platform?: NodeJS.Platform;
  readFile?: (file: string, encoding: 'utf8') => Promise<string>;
  executeFile?: (file: string, args: string[], options: ExecFileOptionsWithStringEncoding) => Promise<{ stdout: string }>;
}

export const readWorkflowProcessStart = async (pid: number, {
  platform = process.platform,
  readFile = fs.readFile,
  executeFile = execFileAsync,
}: ProcessStartOptions = {}) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') {
      const [boot, stat] = await Promise.all([
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        readFile(`/proc/${pid}/stat`, 'utf8'),
      ]);
      const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      if (!boot.trim() || !/^\d+$/.test(start ?? '')) return null;
      return `linux:${boot.trim()}:${start}`;
    }
    const options: ExecFileOptionsWithStringEncoding = { encoding: 'utf8', timeout: 5_000, maxBuffer: 16_384, windowsHide: true };
    if (platform === 'darwin') {
      const { stdout } = await executeFile('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        ...options, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      });
      const start = stdout.trim().replace(/\s+/g, ' ');
      return start ? `darwin:${start}` : null;
    }
    if (platform === 'win32') {
      const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`;
      const { stdout } = await executeFile(powershell, [
        '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
      ], options);
      const start = stdout.trim();
      return /^\d+$/.test(start) ? `win32:${start}` : null;
    }
  } catch {
    return null;
  }
  return null;
};
