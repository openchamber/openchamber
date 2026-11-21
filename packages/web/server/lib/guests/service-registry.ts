
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';
import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { hasErrorCode, hasErrorMessage } from './input-guards.js';

export interface GuestServiceRegistryOptions {
  fs?: typeof fsp;
  execFileAsync?: (file: string, args: string[], options: ExecFileOptionsWithStringEncoding) => Promise<{ stdout: string }>;
  platform?: NodeJS.Platform;
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => boolean;
}

export interface RecordedGuestService {
  pid: number;
  guestId: string;
  token: string;
  entry: string;
}

export const SERVICE_TOKEN_ENV = 'OPENCHAMBER_SERVICE_TOKEN';

const STOP_GRACE_MS = 5_000;
const STOP_POLL_MS = 100;
const PROBE_TIMEOUT_MS = 5_000;

const recordSchema = z.object({
  pid: z.number().int().positive(),
  ownerPid: z.number().int().positive(),
  guestId: z.string(),
  tokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
  execPath: z.string().min(1),
  entry: z.string().min(1),
});

const windowsProcessSchema = z.object({
  commandLine: z.string().nullable(),
  executablePath: z.string().nullable(),
});

export const guestServiceRegistryDir = (dataDir: string) => path.join(dataDir, 'guest-services');

const digestToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

export const createGuestServiceRegistry = ({
  fs = fsp,
  execFileAsync = promisify(execFile),
  platform = process.platform,
  signalProcess = (pid, signal) => process.kill(pid, signal),
}: GuestServiceRegistryOptions = {}) => {
  const isPidAlive = (pid: number) => {
    try {
      signalProcess(pid, 0);
      return true;
    } catch (error) {
      return hasErrorCode(error) && error.code === 'EPERM';
    }
  };

  const recordGuestService = async (dir: string, { pid, guestId, token, entry }: RecordedGuestService) => {
    const record = {
      pid,
      ownerPid: process.pid,
      guestId,
      tokenSha256: digestToken(token),
      execPath: process.execPath,
      entry,
    };
    const filePath = path.join(dir, `${pid}.json`);
    const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
      await fs.rename(tmp, filePath);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      console.warn(`[guests] could not record guest service pid ${pid} for crash recovery: ${(hasErrorCode(error) ? error.code : undefined) ?? (hasErrorMessage(error) ? error.message : undefined) ?? error}`);
    }
  };

  const releaseGuestService = async (dir: string, pid: number) => {
    await fs.rm(path.join(dir, `${pid}.json`), { force: true }).catch(() => {});
  };

  const readLinuxProcess = async (pid: number) => {
    try {
      const [environ, stat] = await Promise.all([
        fs.readFile(`/proc/${pid}/environ`, 'utf8'),
        fs.readFile(`/proc/${pid}/stat`, 'utf8'),
      ]);
      const [, parentPid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const prefix = `${SERVICE_TOKEN_ENV}=`;
      const token = environ.split('\0').find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? null;
      return { parentPid: Number.parseInt(parentPid ?? '', 10), token };
    } catch {
      return null;
    }
  };

  const readPsProcess = async (pid: number) => {
    try {
      const { stdout } = await execFileAsync('ps', ['-E', '-ww', '-o', 'ppid=,command=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
      });
      const parent = stdout.match(/^\s*(\d+)\s/);
      if (!parent) return null;
      const token = stdout.match(new RegExp(`(?:^|\\s)${SERVICE_TOKEN_ENV}=(\\S+)`))?.[1] ?? null;
      return { parentPid: Number.parseInt(parent[1] ?? '', 10), token };
    } catch {
      return null;
    }
  };

  const readWindowsProcess = async (pid: number) => {
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
      'if ($p) { @{ commandLine = $p.CommandLine; executablePath = $p.ExecutablePath } | ConvertTo-Json -Compress }',
    ].join('\n');
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      const { stdout } = await execFileAsync(powershell, [
        '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
      ], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true });
      const parsed = windowsProcessSchema.safeParse(JSON.parse(stdout));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const inspect = async (record: z.infer<typeof recordSchema>): Promise<'gone' | 'owned' | 'orphaned' | 'unknown'> => {
    if (!isPidAlive(record.pid)) return 'gone';
    if (platform === 'win32') {
      const info = await readWindowsProcess(record.pid);
      if (!info) return 'unknown';
      const sameBinary = info.executablePath?.toLowerCase() === record.execPath.toLowerCase();
      if (!sameBinary || !info.commandLine?.includes(record.entry)) return 'gone';
      return isPidAlive(record.ownerPid) ? 'owned' : 'orphaned';
    }
    const info = platform === 'linux' ? await readLinuxProcess(record.pid) : await readPsProcess(record.pid);
    if (!info) return 'unknown';
    if (!info.token || digestToken(info.token) !== record.tokenSha256) return 'gone';
    return info.parentPid === record.ownerPid ? 'owned' : 'orphaned';
  };

  const stopProcess = async (pid: number) => {
    try {
      signalProcess(pid, 'SIGTERM');
    } catch {
      return;
    }
    for (let waited = 0; waited < STOP_GRACE_MS && isPidAlive(pid); waited += STOP_POLL_MS) {
      await sleep(STOP_POLL_MS);
    }
    if (!isPidAlive(pid)) return;
    try {
      signalProcess(pid, 'SIGKILL');
    } catch {
      void 0;
    }
    await sleep(STOP_POLL_MS);
  };

  const reapOrphanedGuestServices = async (dir: string, { log }: { log?: (message: string) => void } = {}) => {
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      return { inspected: 0, reaped: 0 };
    }
    await Promise.all(entries.map(async (name) => {
      const writer = name.match(/\.json\.tmp-(\d+)-[0-9a-f]+$/);
      if (writer && !isPidAlive(Number.parseInt(writer[1] ?? '', 10))) {
        await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
      }
    }));
    const names = entries.filter((name) => name.endsWith('.json'));
    const outcomes = await Promise.all(names.map(async (name) => {
      const filePath = path.join(dir, name);
      try {
        const parsed = recordSchema.safeParse(JSON.parse(await fs.readFile(filePath, 'utf8')));
        if (!parsed.success) {
          await fs.rm(filePath, { force: true });
          return false;
        }
        const record = parsed.data;
        const state = await inspect(record);
        if (state === 'owned' || state === 'unknown') return false;
        if (state === 'orphaned') {
          await stopProcess(record.pid);
          if (isPidAlive(record.pid)) return false;
          log?.(`[guests] stopped guest service ${record.guestId} (pid ${record.pid}) left running by a host that exited`);
        }
        await fs.rm(filePath, { force: true });
        return state === 'orphaned';
      } catch (error) {
        if (error instanceof SyntaxError) await fs.rm(filePath, { force: true }).catch(() => {});
        return false;
      }
    }));
    return { inspected: names.length, reaped: outcomes.filter(Boolean).length };
  };

  return { recordGuestService, releaseGuestService, reapOrphanedGuestServices };
};

const defaultRegistry = createGuestServiceRegistry();

export const recordGuestService = defaultRegistry.recordGuestService;
export const releaseGuestService = defaultRegistry.releaseGuestService;
export const reapOrphanedGuestServices = defaultRegistry.reapOrphanedGuestServices;
