// Managed OpenCode process registry + orphan reaper — VS Code parity copy.
//
// The VS Code extension does NOT bundle the web package, so it cannot import
// the web runtime's registry module. This is a parity implementation that
// reads/writes the SAME on-disk registry directory and uses the SAME algorithm,
// so a process spawned by any runtime (web, desktop, VS Code) can be reaped by
// any other.
//
// Storage is ONE FILE PER SPAWNED PROCESS (`<childPid>.json`) in a registry
// directory — never a single shared JSON file — because multiple runtimes and
// windows run concurrently and a shared file would be clobbered by the
// read-modify-write race. Per-process files mean each instance only ever writes
// or deletes its OWN file.
//
// See packages/web/server/lib/opencode/managed-process-registry.js for the full
// rationale and safety model. In short: we only ever kill pids THIS product
// recorded, re-verified as a live `opencode serve`, and only when their spawner
// is provably gone (reparented to pid 1, or recorded owner pid dead).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

type ManagedProcessEntry = {
  pid: number;
  ownerPid: number;
  port: number | null;
  binary: string | null;
  runtime: string;
  startedAt: string;
};

const resolveRegistryDir = (): string => {
  const override = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), '.config', 'openchamber', 'managed-opencode');
};

const entryFilePath = (pid: number): string => path.join(resolveRegistryDir(), `${pid}.json`);

const writeEntryFile = (entry: ManagedProcessEntry): void => {
  const dir = resolveRegistryDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${entry.pid}.json`);
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
    fs.renameSync(tmp, filePath);
  } catch {
    // Best-effort: a failed registry write must never break spawn/shutdown.
  }
};

const readAllEntries = (): Array<{ entry: ManagedProcessEntry; filePath: string }> => {
  const dir = resolveRegistryDir();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Array<{ entry: ManagedProcessEntry; filePath: string }> = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      const entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (entry && Number.isInteger(entry.pid)) {
        out.push({ entry: entry as ManagedProcessEntry, filePath });
      } else {
        fs.rmSync(filePath, { force: true });
      }
    } catch {
      try { fs.rmSync(filePath, { force: true }); } catch { /* ignore */ }
    }
  }
  return out;
};

export const registerManagedProcess = (input: {
  pid: number | undefined;
  ownerPid?: number;
  port?: number | null;
  binary?: string | null;
  runtime?: string;
}): void => {
  const pid = input.pid;
  if (!Number.isInteger(pid)) return;
  writeEntryFile({
    pid: pid as number,
    ownerPid: Number.isInteger(input.ownerPid) ? (input.ownerPid as number) : process.pid,
    port: Number.isInteger(input.port as number) ? (input.port as number) : null,
    binary: typeof input.binary === 'string' ? input.binary : null,
    runtime: typeof input.runtime === 'string' ? input.runtime : 'vscode',
    startedAt: new Date().toISOString(),
  });
};

export const unregisterManagedProcess = (pid: number | undefined): void => {
  if (!Number.isInteger(pid)) return;
  try {
    fs.rmSync(entryFilePath(pid as number), { force: true });
  } catch {
    // ignore
  }
};

const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const readUnixProcInfo = (pid: number): { ppid: number; command: string } | null => {
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'ppid=,command='], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    const line = (result.stdout || '').trim();
    if (!line) return null;
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) return null;
    return { ppid: Number.parseInt(match[1], 10), command: match[2] };
  } catch {
    return null;
  }
};

const readWindowsImageName = (pid: number): string | null => {
  try {
    const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    return (result.stdout || '').trim() || null;
  } catch {
    return null;
  }
};

const commandIdentifiesOurServer = (command: string, entry: ManagedProcessEntry): boolean => {
  if (typeof command !== 'string') return false;
  const lower = command.toLowerCase();
  if (!lower.includes('opencode') || !lower.includes('serve')) return false;
  if (Number.isInteger(entry.port) && !command.includes(String(entry.port))) return false;
  return true;
};

const killOrphan = async (pid: number): Promise<void> => {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    } catch {
      // ignore
    }
    return;
  }

  const signalTree = (signal: NodeJS.Signals) => {
    try { process.kill(-pid, signal); } catch { /* ignore */ }
    try { process.kill(pid, signal); } catch { /* ignore */ }
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

const processEntry = async (
  entry: ManagedProcessEntry,
  log?: (message: string) => void,
): Promise<boolean> => {
  if (!isPidAlive(entry.pid)) return false;

  const ownerGone = Number.isInteger(entry.ownerPid) && !isPidAlive(entry.ownerPid);

  if (process.platform === 'win32') {
    const image = readWindowsImageName(entry.pid);
    const looksLikeOpencode = typeof image === 'string' && image.toLowerCase().includes('opencode');
    if (looksLikeOpencode && ownerGone) {
      await killOrphan(entry.pid);
      log?.(`[opencode] reaped orphaned process pid ${entry.pid} (owner ${entry.ownerPid} gone)`);
      return true;
    }
    return false;
  }

  const info = readUnixProcInfo(entry.pid);
  if (!info || !commandIdentifiesOurServer(info.command, entry)) return false;

  const orphaned = info.ppid === 1 || ownerGone;
  if (!orphaned) return false;

  await killOrphan(entry.pid);
  log?.(`[opencode] reaped orphaned process pid ${entry.pid} (reparented/owner gone)`);
  return true;
};

export const reapOrphanedProcesses = async (
  options: { log?: (message: string) => void } = {},
): Promise<{ inspected: number; reaped: number }> => {
  const { log } = options;
  const records = readAllEntries();
  if (records.length === 0) return { inspected: 0, reaped: 0 };

  let reaped = 0;
  for (const { entry, filePath } of records) {
    let drop = false;
    try {
      const wasReaped = await processEntry(entry, log);
      if (wasReaped) reaped += 1;
      drop = wasReaped || !isPidAlive(entry.pid);
    } catch (error) {
      log?.(`[opencode] reap check failed for pid ${entry.pid}: ${error instanceof Error ? error.message : error}`);
    }
    if (drop) {
      try { fs.rmSync(filePath, { force: true }); } catch { /* ignore */ }
    }
  }

  return { inspected: records.length, reaped };
};
