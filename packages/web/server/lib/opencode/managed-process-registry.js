// Managed OpenCode process registry + orphan reaper.
//
// OpenChamber spawns the OpenCode server as an EXTERNAL child binary (on Unix
// with `detached: true`, so it leads its own process group). That binary can
// therefore outlive its parent if the parent is hard-killed/crashes/`Ctrl+C`ed
// before graceful teardown runs — leaving an orphaned `opencode serve` that
// then contends on the shared SQLite DB and slows everything down.
//
// We cannot tie an arbitrary external binary to the parent's death portably
// (Electron's `utilityProcess` would, but it only runs JS entrypoints, not a
// standalone binary). So we use the same pattern OpenCode's own CLI daemon uses
// for its detached server: an on-disk record of the pids WE spawned, plus a
// startup reaper that kills ONLY our own, verified, genuinely-orphaned
// processes — never a process a live instance (another desktop window, a VS
// Code host, the user's standalone `opencode`) is actively using.
//
// Storage: ONE FILE PER SPAWNED PROCESS in a registry directory, named
// `<childPid>.json`. Multiple runtimes (web/desktop/VS Code) and multiple
// windows all run concurrently; a single shared JSON file would be corrupted by
// the read-modify-write race (last writer wins, clobbering another instance's
// entry). Per-process files mean every instance only ever writes/deletes its
// OWN file, so there is no write contention at all.
//
// Safety model (why this never kills the wrong thing):
//   1. The reaper only ever considers pids THIS product recorded. The user's
//      standalone CLI server, the official desktop app, and the TUI are never
//      recorded, so they are never even candidates.
//   2. Before killing, it re-verifies the live pid is still an `opencode serve`
//      matching the recorded port (guards against the OS recycling a dead pid
//      onto an unrelated process).
//   3. It kills only when the spawning owner is provably gone — the child has
//      been reparented to init/pid 1, or the recorded owner pid is dead. A
//      child still owned by a live instance is left untouched.
//
// The VS Code extension cannot import this module (it does not bundle the web
// package); it carries a parity implementation that reads/writes the SAME dir.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const resolveRegistryDir = () => {
  const override = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), '.config', 'openchamber', 'managed-opencode');
};

const entryFilePath = (pid) => path.join(resolveRegistryDir(), `${pid}.json`);

const writeEntryFile = (entry) => {
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

const readAllEntries = () => {
  const dir = resolveRegistryDir();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      const entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (entry && Number.isInteger(entry.pid)) {
        out.push({ entry, filePath });
      } else {
        fs.rmSync(filePath, { force: true });
      }
    } catch {
      // Corrupt/partial file — drop it.
      try { fs.rmSync(filePath, { force: true }); } catch {}
    }
  }
  return out;
};

/** Record an OpenCode process WE spawned so a future run can reap it if orphaned. */
export const registerManagedProcess = ({ pid, ownerPid, port, binary, runtime } = {}) => {
  if (!Number.isInteger(pid)) return;
  writeEntryFile({
    pid,
    ownerPid: Number.isInteger(ownerPid) ? ownerPid : process.pid,
    port: Number.isInteger(port) ? port : null,
    binary: typeof binary === 'string' ? binary : null,
    runtime: typeof runtime === 'string' ? runtime : 'web',
    startedAt: new Date().toISOString(),
  });
};

/** Drop a pid from the registry (after we have killed/closed it ourselves). */
export const unregisterManagedProcess = (pid) => {
  if (!Number.isInteger(pid)) return;
  try {
    fs.rmSync(entryFilePath(pid), { force: true });
  } catch {
  }
};

const isPidAlive = (pid) => {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = process exists but we lack permission to signal it → still alive.
    return error?.code === 'EPERM';
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Returns { ppid, command } for a live pid on Unix, or null if it can't be read.
const readUnixProcInfo = (pid) => {
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

// Windows image name for a pid (e.g. "opencode.exe"), or null.
const readWindowsImageName = (pid) => {
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

const commandIdentifiesOurServer = (command, entry) => {
  if (typeof command !== 'string') return false;
  const lower = command.toLowerCase();
  if (!lower.includes('opencode') || !lower.includes('serve')) return false;
  // Tie to the exact server we registered when we know its port, so a recycled
  // pid running a *different* opencode server is never mistaken for ours.
  if (Number.isInteger(entry.port) && !command.includes(String(entry.port))) return false;
  return true;
};

const killOrphan = async (pid) => {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    } catch {
    }
    return;
  }

  const signalTree = (signal) => {
    try { process.kill(-pid, signal); } catch {}
    try { process.kill(pid, signal); } catch {}
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

// Decide+act on a single registry entry. Returns true if it was reaped.
const processEntry = async (entry, { log }) => {
  // Dead pid → nothing to do (caller drops the file).
  if (!isPidAlive(entry.pid)) return false;

  const ownerGone = Number.isInteger(entry.ownerPid) && !isPidAlive(entry.ownerPid);

  if (process.platform === 'win32') {
    const image = readWindowsImageName(entry.pid);
    const looksLikeOpencode = typeof image === 'string' && image.toLowerCase().includes('opencode');
    // Windows lacks reliable reparent-to-1 semantics (job objects usually kill
    // children with the parent), so we reap only when the owner is provably dead
    // AND the image still looks like opencode.
    if (looksLikeOpencode && ownerGone) {
      await killOrphan(entry.pid);
      log?.(`[lifecycle] reaped orphaned OpenCode pid ${entry.pid} (owner ${entry.ownerPid} gone)`);
      return true;
    }
    return false;
  }

  const info = readUnixProcInfo(entry.pid);
  // Can't verify identity (or it's not our server) → leave it alone.
  if (!info || !commandIdentifiesOurServer(info.command, entry)) return false;

  const orphaned = info.ppid === 1 || ownerGone;
  if (!orphaned) return false; // still owned by a live instance

  await killOrphan(entry.pid);
  log?.(`[lifecycle] reaped orphaned OpenCode pid ${entry.pid} (reparented/owner gone)`);
  return true;
};

/**
 * Kill any genuinely-orphaned OpenCode processes WE previously spawned, and
 * prune their registry files. Safe to call at startup before spawning a new
 * server. Returns { inspected, reaped }.
 */
export const reapOrphanedProcesses = async ({ log } = {}) => {
  const records = readAllEntries();
  if (records.length === 0) return { inspected: 0, reaped: 0 };

  let reaped = 0;
  for (const { entry, filePath } of records) {
    let drop = false;
    try {
      const wasReaped = await processEntry(entry, { log });
      if (wasReaped) reaped += 1;
      // Drop the file when the process is gone (reaped now, or already dead);
      // keep it only while the process is still alive and owned by a live owner.
      drop = wasReaped || !isPidAlive(entry.pid);
    } catch (error) {
      log?.(`[lifecycle] reap check failed for pid ${entry.pid}: ${error?.message ?? error}`);
    }
    if (drop) {
      try { fs.rmSync(filePath, { force: true }); } catch {}
    }
  }

  return { inspected: records.length, reaped };
};
