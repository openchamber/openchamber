// Guest service pid registry and boot reaper.
//
// A graceful shutdown stops every guest service (`service.js`), but a host that
// dies hard (SIGKILL, an OOM kill, power loss) takes its in-memory runtime map
// with it and leaves the services running with no parent. They keep their
// loopback port and whatever sockets or locks they hold until the next reboot.
//
// So every spawn writes one file, `<pid>.json`, into a registry directory, and
// removes it once the child exits. A starting host reads that directory and
// stops each recorded service that is still running and whose host is gone.
// One file per process: web and desktop share a data directory and run at the
// same time, and each host only ever writes and deletes its own files.
//
// A pid alone proves nothing once its process is gone, because the OS hands
// pids out again. Before a kill the reaper checks two things:
//   1. The process is the service that was recorded. On Linux and macOS its
//      environment must carry the service token whose SHA-256 the record holds
//      (`/proc/<pid>/environ`, `ps -E`); the token itself never reaches the
//      disk. Windows does not expose another process's environment, so there
//      the command line must name the recorded entry script and the executable
//      must be the recorded host binary.
//   2. Its host is gone. On Unix a parent pid changes only when the parent
//      dies, so a parent other than the recorded owner means the owner exited.
//      Windows never reparents, so there the owner pid must be dead.
// A process that fails the first check is no longer ours and its record goes.
// A process that cannot be read is left alone and its record stays.
//
// Everything here is asynchronous: the server shares its event loop with the
// desktop shell's UI traffic.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

/** The service's bearer, set by `service.js` in every service environment. */
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

/** `{openchamberDataDir}/guest-services`. */
export const guestServiceRegistryDir = (dataDir) => path.join(dataDir, 'guest-services');

const digestToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Builds the registry over injectable OS access. Production uses the default
 * instance exported below; tests pass their own platform, process and
 * child-process helpers instead of mocking node builtins.
 */
export const createGuestServiceRegistry = ({
  fs = fsp,
  execFileAsync = promisify(execFile),
  platform = process.platform,
  signalProcess = (pid, signal) => process.kill(pid, signal),
} = {}) => {
  const isPidAlive = (pid) => {
    try {
      signalProcess(pid, 0);
      return true;
    } catch (error) {
      // EPERM: the process exists, it just is not ours to signal.
      return error?.code === 'EPERM';
    }
  };

  /**
   * Records a service this host just spawned. A failed write turns off crash
   * recovery for that one process, never the spawn.
   * @param {string} dir
   * @param {{ pid: number, guestId: string, token: string, entry: string }} service
   */
  const recordGuestService = async (dir, { pid, guestId, token, entry }) => {
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
      console.warn(`[guests] could not record guest service pid ${pid} for crash recovery: ${error?.code ?? error?.message ?? error}`);
    }
  };

  /**
   * Drops a service's record once its process has exited.
   * @param {string} dir
   * @param {number} pid
   */
  const releaseGuestService = async (dir, pid) => {
    await fs.rm(path.join(dir, `${pid}.json`), { force: true }).catch(() => {});
  };

  const readLinuxProcess = async (pid) => {
    try {
      const [environ, stat] = await Promise.all([
        fs.readFile(`/proc/${pid}/environ`, 'utf8'),
        fs.readFile(`/proc/${pid}/stat`, 'utf8'),
      ]);
      // `pid (comm) state ppid ...`; comm may itself hold spaces and parens.
      const [, parentPid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const prefix = `${SERVICE_TOKEN_ENV}=`;
      const token = environ.split('\0').find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? null;
      return { parentPid: Number.parseInt(parentPid, 10), token };
    } catch {
      return null;
    }
  };

  // macOS and the BSDs: `ps -E` appends the environment of a process the
  // caller owns to its command line.
  const readPsProcess = async (pid) => {
    try {
      const { stdout } = await execFileAsync('ps', ['-E', '-ww', '-o', 'ppid=,command=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
      });
      const parent = stdout.match(/^\s*(\d+)\s/);
      if (!parent) return null;
      const token = stdout.match(new RegExp(`(?:^|\\s)${SERVICE_TOKEN_ENV}=(\\S+)`))?.[1] ?? null;
      return { parentPid: Number.parseInt(parent[1], 10), token };
    } catch {
      return null;
    }
  };

  const readWindowsProcess = async (pid) => {
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

  /** @returns {Promise<'gone' | 'owned' | 'orphaned' | 'unknown'>} */
  const inspect = async (record) => {
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

  // Same sequence as a host stop: SIGTERM, then SIGKILL after the grace period.
  const stopProcess = async (pid) => {
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
      // exited in between
    }
    await sleep(STOP_POLL_MS);
  };

  /**
   * Stops every recorded service whose host is gone and prunes the records of
   * processes that no longer exist. Never rejects.
   * @param {string} dir
   * @param {{ log?: (message: string) => void }} [options]
   * @returns {Promise<{ inspected: number, reaped: number }>}
   */
  const reapOrphanedGuestServices = async (dir, { log } = {}) => {
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      return { inspected: 0, reaped: 0 };
    }
    // A host that died between the write and the rename of a record leaves its
    // temp file behind; the writer's pid is in the name.
    await Promise.all(entries.map(async (name) => {
      const writer = name.match(/\.json\.tmp-(\d+)-[0-9a-f]+$/);
      if (writer && !isPidAlive(Number.parseInt(writer[1], 10))) {
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
        // A corrupt record, or one that vanished: drop it and move on.
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
