
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const defaultExecFileAsync = promisify(execFile);

const resolveRegistryDir = () => {
  const override = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), '.config', 'openchamber', 'managed-opencode');
};

const entryFilePath = (pid) => path.join(resolveRegistryDir(), `${pid}.json`);

const isPidAlive = (pid) => {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const commandIdentifiesOurServer = (command, entry) => {
  if (typeof command !== 'string') return false;
  const lower = command.toLowerCase();
  if (!lower.includes('opencode') || !lower.includes('serve')) return false;
  if (Number.isInteger(entry.port) && !command.includes(String(entry.port))) return false;
  return true;
};

export const createManagedProcessRegistry = ({ fs = fsp, execFileAsync = defaultExecFileAsync } = {}) => {
  const writeEntryFile = async (entry) => {
    const dir = resolveRegistryDir();
    try {
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${entry.pid}.json`);
      const tmp = `${filePath}.tmp-${process.pid}`;
      await fs.writeFile(tmp, JSON.stringify(entry, null, 2));
      await fs.rename(tmp, filePath);
    } catch {
      // Best-effort: a failed registry write must never break spawn/shutdown.
    }
  };

  const readAllEntries = async () => {
    const dir = resolveRegistryDir();
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names.filter((value) => value.endsWith('.json'))) {
      const filePath = path.join(dir, name);
      try {
        const entry = JSON.parse(await fs.readFile(filePath, 'utf8'));
        if (entry && Number.isInteger(entry.pid)) {
          out.push({ entry, filePath });
        } else {
          await fs.rm(filePath, { force: true });
        }
      } catch {
        try {
          await fs.rm(filePath, { force: true });
        } catch {
          // ignore
        }
      }
    }
    return out;
  };

  const registerManagedProcess = async ({ pid, ownerPid, port, binary, runtime } = {}) => {
    if (!Number.isInteger(pid)) return;
    await writeEntryFile({
      pid,
      ownerPid: Number.isInteger(ownerPid) ? ownerPid : process.pid,
      port: Number.isInteger(port) ? port : null,
      binary: typeof binary === 'string' ? binary : null,
      runtime: typeof runtime === 'string' ? runtime : 'web',
      startedAt: new Date().toISOString(),
    });
  };

  const unregisterManagedProcess = async (pid) => {
    if (!Number.isInteger(pid)) return;
    try {
      await fs.rm(entryFilePath(pid), { force: true });
    } catch {
      // Best-effort: dropping a missing file is not an error.
    }
  };

  const readUnixProcInfo = async (pid) => {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'ppid=,command='], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      const line = (stdout || '').trim();
      if (!line) return null;
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!match) return null;
      return { ppid: Number.parseInt(match[1], 10), command: match[2] };
    } catch {
      return null;
    }
  };

  const readWindowsImageName = async (pid) => {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      return (stdout || '').trim() || null;
    } catch {
      return null;
    }
  };

  const killOrphan = async (pid) => {
    if (process.platform === 'win32') {
      try {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          timeout: 5000,
          windowsHide: true,
        });
      } catch {
        // Best-effort: a failed kill is not fatal (startup reaper is a backstop).
      }
      return;
    }

    const signalTree = (signal) => {
      try {
        process.kill(-pid, signal);
      } catch {
        // process group may already be gone
      }
      try {
        process.kill(pid, signal);
      } catch {
        // pid may already be gone
      }
    };

    signalTree('SIGTERM');
    for (let waited = 0; waited < 1500 && isPidAlive(pid); waited += 150) {
      await sleep(150);
    }
    if (isPidAlive(pid)) {
      signalTree('SIGKILL');
      await sleep(300);
    }
  };

  const processEntry = async (entry, { log }) => {
    if (!isPidAlive(entry.pid)) return false;

    const ownerGone = Number.isInteger(entry.ownerPid) && !isPidAlive(entry.ownerPid);

    if (process.platform === 'win32') {
      const image = await readWindowsImageName(entry.pid);
      const looksLikeOpencode = typeof image === 'string' && image.toLowerCase().includes('opencode');
      if (looksLikeOpencode && ownerGone) {
        await killOrphan(entry.pid);
        log?.(`[lifecycle] reaped orphaned OpenCode pid ${entry.pid} (owner ${entry.ownerPid} gone)`);
        return true;
      }
      return false;
    }

    const info = await readUnixProcInfo(entry.pid);
    if (!info || !commandIdentifiesOurServer(info.command, entry)) return false;

    const orphaned = info.ppid === 1 || ownerGone;
    if (!orphaned) return false;

    await killOrphan(entry.pid);
    log?.(`[lifecycle] reaped orphaned OpenCode pid ${entry.pid} (reparented/owner gone)`);
    return true;
  };

  const reapOrphanedProcesses = async ({ log } = {}) => {
    const records = await readAllEntries();
    if (records.length === 0) return { inspected: 0, reaped: 0 };

    let reaped = 0;
    for (const { entry, filePath } of records) {
      let drop = false;
      try {
        const wasReaped = await processEntry(entry, { log });
        if (wasReaped) reaped += 1;
        drop = wasReaped || !isPidAlive(entry.pid);
      } catch (error) {
        log?.(`[lifecycle] reap check failed for pid ${entry.pid}: ${error?.message ?? error}`);
      }
      if (drop) {
        try {
          await fs.rm(filePath, { force: true });
        } catch {
          // best-effort
        }
      }
    }

    return { inspected: records.length, reaped };
  };

  return { registerManagedProcess, unregisterManagedProcess, reapOrphanedProcesses };
};

const defaultRegistry = createManagedProcessRegistry();

export const registerManagedProcess = defaultRegistry.registerManagedProcess;
export const unregisterManagedProcess = defaultRegistry.unregisterManagedProcess;
export const reapOrphanedProcesses = defaultRegistry.reapOrphanedProcesses;
