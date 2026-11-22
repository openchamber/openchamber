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
// All filesystem and child-process operations here are ASYNCHRONOUS. The web
// server runs in-process inside the Electron main event loop (and other hosts),
// so any `spawnSync`/`*Sync` FS call blocks the single event loop — which also
// serves UI asset requests and realtime SSE traffic. The startup reaper can
// iterate several registry entries and, on Windows, each one spawns `tasklist`
// (100-500ms) and possibly `taskkill`; doing that synchronously stalls the
// whole process and is what caused the 1.13.3 `openchamber-ui://` lag
// regression (#1841). `execFile`/`fsp.*` keep the event loop responsive while
// the reaper waits on the kernel.
//
// The VS Code extension cannot import this module (it does not bundle the web
// package); it carries a parity implementation that reads/writes the SAME dir.

import fsp from 'node:fs/promises';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { renameWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFile, readBoundedFileSync } from '../shared/bounded-file-read.js';
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

// Entries are small fixed-shape records (pid, ownerPid, port, binary path,
// runtime, timestamp); claim files hold one pid integer. Both are read
// through the shared bounded reader (#1736) under caps sized for those
// shapes, so a FIFO or a grown file at a registry path is refused promptly
// to the existing safe defaults instead of freezing the sync launch
// decision, wedging the async reaper, or being buffered whole.
const MANAGED_PROCESS_ENTRY_MAX_BYTES = 64 * 1024;
const MANAGED_PROCESS_CLAIM_MAX_BYTES = 1024;

const readBoundedTextSync = (filePath, maxBytes) => {
  const result = readBoundedFileSync(filePath, maxBytes);
  if (!result.ok) return null;
  return result.buffer.toString('utf8');
};

/**
 * The OpenChamber process that registered OpenCode `pid`, or null when the
 * registry has no readable entry for it. Synchronous, for the launch decision.
 */
export const readManagedProcessOwner = (pid) => {
  if (!Number.isInteger(pid)) return null;
  try {
    const raw = readBoundedTextSync(entryFilePath(pid), MANAGED_PROCESS_ENTRY_MAX_BYTES);
    if (raw === null) return null;
    const entry = JSON.parse(raw);
    return Number.isInteger(entry?.ownerPid) ? entry.ownerPid : null;
  } catch {
    return null;
  }
};

/**
 * Claims OpenCode `pid` after its registered owner `fromOwner` is gone. Two
 * servers on one data dir can find the same orphan at once; the claim file is
 * named after the owner it is taken from and created exclusively, so only one
 * of them can take it from that owner (the winner then re-registers itself,
 * so the next handover has another name). Returns the server holding the
 * claim: `claimant` when it won or already held it, another pid otherwise, or
 * null when the claim could not be read.
 */
export const claimManagedProcess = (pid, fromOwner, claimant = process.pid) => {
  const claimPath = path.join(resolveRegistryDir(), `${pid}.claim-from-${fromOwner}`);
  const readHolder = (holderPath = claimPath) => {
    try {
      const raw = readBoundedTextSync(holderPath, MANAGED_PROCESS_CLAIM_MAX_BYTES);
      if (raw === null) return null;
      const holder = Number.parseInt(raw.trim(), 10);
      return Number.isInteger(holder) ? holder : null;
    } catch {
      return null;
    }
  };
  try {
    mkdirSync(resolveRegistryDir(), { recursive: true });
    writeFileSync(claimPath, String(claimant), { flag: 'wx' });
    return claimant;
  } catch (error) {
    if (error?.code !== 'EEXIST') return null;
  }
  const holder = readHolder();
  if (holder === null || holder === claimant || isPidAlive(holder)) return holder;
  // The recorded holder is gone: its claim has no end of life of its own, so
  // it must not answer ownership questions (or block adoption) forever.
  // Supersede it — but never by blindly removing the file: two servers can
  // read the same dead holder, and the loser's remove would delete the
  // winner's freshly created live claim, letting both adopt the process.
  // Move the file aside instead (rename is atomic, so only one superseder
  // moves it), verify the moved file still names the dead holder, and only
  // then drop it and re-run the exclusive create. A moved file naming
  // anyone else is a live claim caught in the race: put it back untouched
  // and report its holder.
  const asidePath = `${claimPath}.superseding-${claimant}`;
  try {
    renameSync(claimPath, asidePath);
  } catch {
    return readHolder();
  }
  let movedHolder = null;
  try {
    const raw = readBoundedTextSync(asidePath, MANAGED_PROCESS_CLAIM_MAX_BYTES);
    const moved = raw === null ? Number.NaN : Number.parseInt(raw.trim(), 10);
    movedHolder = Number.isInteger(moved) ? moved : null;
  } catch {
    movedHolder = null;
  }
  if (movedHolder !== holder) {
    try {
      renameSync(asidePath, claimPath);
    } catch {
      // The slot was taken while restoring: recreate the displaced claim if
      // it is still the best record available, otherwise leave the winner's.
      try {
        writeFileSync(claimPath, String(movedHolder), { flag: 'wx' });
      } catch {
        // A newer claim owns the slot now; it wins.
      }
    }
    return movedHolder ?? readHolder();
  }
  rmSync(asidePath, { force: true });
  try {
    writeFileSync(claimPath, String(claimant), { flag: 'wx' });
    return claimant;
  } catch (error) {
    if (error?.code !== 'EEXIST') return null;
    return readHolder();
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

// Exported for the managed-servers read (managed-servers.js via
// lifecycle.js), which must make the same identity judgement as the
// reaper before it presents a recorded pid as a live server.
export const commandIdentifiesOurServer = (command, entry) => {
  if (typeof command !== 'string') return false;
  const lower = command.toLowerCase();
  if (!lower.includes('opencode') || !lower.includes('serve')) return false;
  // Tie to the exact server we registered when we know its port, so a recycled
  // pid running a *different* opencode server is never mistaken for ours.
  // The port is parsed from the `--port` argument, never substring-matched:
  // a command serving port 50010 must not satisfy a record for port 5001.
  if (Number.isInteger(entry.port)) {
    const portMatch = command.match(/--port(?:=|\s+)(\d+)/);
    if (!portMatch || Number.parseInt(portMatch[1], 10) !== entry.port) return false;
  }
  return true;
};

/**
 * Build the registry API over injectable filesystem and child-process
 * dependencies. Production callers use the default instance exported below;
 * tests pass their own `fs`/`execFileAsync` instead of mocking node builtins.
 */
export const createManagedProcessRegistry = ({ fs = fsp, execFileAsync = defaultExecFileAsync, boundedRead = readBoundedFile } = {}) => {
  // Async spelling of readBoundedTextSync for the injected-fs seam: a
  // non-ok bounded result (missing / not-regular / too-large) throws a
  // coded error so each caller's existing corrupt-file handling applies.
  const readBoundedText = async (filePath, maxBytes) => {
    const result = await boundedRead(filePath, maxBytes);
    if (!result.ok) {
      const error = new Error(result.code ?? 'BOUNDED_FILE_READ_FAILED');
      error.code = result.code;
      throw error;
    }
    return result.buffer.toString('utf8');
  };
  // Claim files (`<pid>.claim-from-<owner>`, written by claimManagedProcess)
  // are the handover record between servers. They get an end of life here:
  // unregister drops the claimed pid's files, and the reaper sweeps files
  // whose recorded holder is dead.
  const claimFilePattern = /^(\d+)\.claim-from-(\d+)$/;
  const listClaimFiles = async () => {
    const dir = resolveRegistryDir();
    let names = [];
    try {
      const listed = await fs.readdir(dir);
      names = Array.isArray(listed) ? listed : [];
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      const match = claimFilePattern.exec(name);
      if (match) {
        out.push({ pid: Number.parseInt(match[1], 10), filePath: path.join(dir, name) });
      }
    }
    return out;
  };

  const removeClaimFilesForPid = async (pid) => {
    for (const claim of await listClaimFiles()) {
      if (claim.pid !== pid) continue;
      try {
        await fs.rm(claim.filePath, { force: true });
      } catch {
        // Best-effort: a stuck claim file is swept by the reaper later.
      }
    }
  };

  // Bounded-read outcomes that can never succeed on a later sweep: the
  // file is not a regular file, or it is over the claim cap. Every other
  // failure (a vanished file, EACCES/EIO) is transient and keeps the
  // leave-for-a-later-sweep behaviour.
  const PERMANENT_CLAIM_READ_CODES = new Set(['BOUNDED_FILE_NOT_REGULAR', 'BOUNDED_FILE_TOO_LARGE']);

  const sweepDeadHolderClaims = async ({ log } = {}) => {
    let reapedClaims = 0;
    let unreadableClaims = 0;
    for (const claim of await listClaimFiles()) {
      let holder;
      try {
        holder = Number.parseInt((await readBoundedText(claim.filePath, MANAGED_PROCESS_CLAIM_MAX_BYTES)).trim(), 10);
      } catch (error) {
        if (!PERMANENT_CLAIM_READ_CODES.has(error?.code)) {
          // Transiently unreadable claim files are left for a later sweep,
          // never guessed at.
          continue;
        }
        unreadableClaims += 1;
        // The claim's content can never be read, so judge it by the pid
        // its filename encodes (#1822): a claim for a dead pid hands over
        // nothing, whatever its unreadable content says. A live filename
        // pid keeps its claim - the content may be a live holder's record
        // in a shape this reader rejects.
        if (isPidAlive(claim.pid)) {
          log?.(`[lifecycle] permanently unreadable claim for live pid ${claim.pid} left in place (${error.code})`);
          continue;
        }
        // Same move-aside caution as the readable path: a claimant may
        // have replaced the unreadable file with a readable claim since
        // the read above. Reap only when the moved file is still
        // permanently unreadable; restore anything else untouched.
        const asidePath = `${claim.filePath}.sweeping-${process.pid}`;
        try {
          await fs.rename(claim.filePath, asidePath);
        } catch {
          continue;
        }
        let stillUnreadable = false;
        try {
          await readBoundedText(asidePath, MANAGED_PROCESS_CLAIM_MAX_BYTES);
        } catch (movedError) {
          stillUnreadable = PERMANENT_CLAIM_READ_CODES.has(movedError?.code);
        }
        if (!stillUnreadable || isPidAlive(claim.pid)) {
          try {
            await fs.rename(asidePath, claim.filePath);
          } catch {
            // Slot taken while restoring; the newer claim wins.
            await fs.rm(asidePath, { force: true }).catch(() => {});
          }
          continue;
        }
        await fs.rm(asidePath, { force: true });
        reapedClaims += 1;
        log?.(`[lifecycle] reaped permanently unreadable claim for dead pid ${claim.pid} (${error.code})`);
        continue;
      }
      try {
        if (!Number.isInteger(holder) || isPidAlive(holder)) continue;
        // Same race as claim supersession: a claimant may have replaced the
        // stale file with a live claim since the read above. Move the file
        // aside (atomic), verify the moved file still names the dead
        // holder, and restore it untouched when it does not.
        const asidePath = `${claim.filePath}.sweeping-${process.pid}`;
        await fs.rename(claim.filePath, asidePath);
        let movedHolder = null;
        try {
          const moved = Number.parseInt((await readBoundedText(asidePath, MANAGED_PROCESS_CLAIM_MAX_BYTES)).trim(), 10);
          movedHolder = Number.isInteger(moved) ? moved : null;
        } catch {
          movedHolder = null;
        }
        if (movedHolder !== holder) {
          try {
            await fs.rename(asidePath, claim.filePath);
          } catch {
            // Slot taken while restoring; the newer claim wins.
            await fs.rm(asidePath, { force: true }).catch(() => {});
          }
          continue;
        }
        await fs.rm(asidePath, { force: true });
        reapedClaims += 1;
      } catch {
        // Unreadable claim files are left for a later sweep, never guessed at.
      }
    }
    if (unreadableClaims > 0) {
      log?.(`[lifecycle] claim sweep: ${unreadableClaims} permanently unreadable claim(s) seen, ${reapedClaims} dead-holder claim(s) reaped`);
    }
    return { reapedClaims, unreadableClaims };
  };

  const writeEntryFile = async (entry) => {
    const dir = resolveRegistryDir();
    try {
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${entry.pid}.json`);
      const tmp = `${filePath}.tmp-${process.pid}`;
      await fs.writeFile(tmp, JSON.stringify(entry, null, 2));
      await renameWithRetry((from, to) => fs.rename(from, to), tmp, filePath);
    } catch {
      // Best-effort: a failed registry write must never break spawn/shutdown.
    }
  };

  const readAllEntries = async ({ pruneInvalid = true, throwOnDirError = false } = {}) => {
    const dir = resolveRegistryDir();
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      // A missing registry directory is an empty registry; any other failure
      // is a failed read, and read-only consumers asked to hear about it
      // instead of mistaking it for "no servers".
      if (throwOnDirError && error?.code !== 'ENOENT') throw error;
      return [];
    }
    const out = [];
    for (const name of names.filter((value) => value.endsWith('.json'))) {
      const filePath = path.join(dir, name);
      try {
        const entry = JSON.parse(await readBoundedText(filePath, MANAGED_PROCESS_ENTRY_MAX_BYTES));
        if (entry && Number.isInteger(entry.pid)) {
          out.push({ entry, filePath });
        } else if (pruneInvalid) {
          await fs.rm(filePath, { force: true });
        }
      } catch {
        // Corrupt/partial file — the reaper drops it; a read-only read
        // (pruneInvalid false) must never delete another instance's file.
        if (pruneInvalid) {
          try {
            await fs.rm(filePath, { force: true });
          } catch {
            // ignore
          }
        }
      }
    }
    return out;
  };

  /** Record an OpenCode process WE spawned so a future run can reap it if orphaned. */
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

  /** Drop a pid from the registry (after we have killed/closed it ourselves). */
  const unregisterManagedProcess = async (pid) => {
    if (!Number.isInteger(pid)) return;
    try {
      await fs.rm(entryFilePath(pid), { force: true });
    } catch {
      // Best-effort: dropping a missing file is not an error.
    }
    // The pid is gone from the registry, so its handover claims are over:
    // leaving them would leak a file per handover and let a dead holder
    // keep answering ownership questions for this pid.
    await removeClaimFilesForPid(pid);
  };

  // Returns { ppid, command } for a live pid on Unix, or null if it can't be read.
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

  // Windows image name for a pid (e.g. "opencode.exe"), or null.
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

  // Decide+act on a single registry entry. Returns true if it was reaped.
  const processEntry = async (entry, { log }) => {
    // Dead pid → nothing to do (caller drops the file).
    if (!isPidAlive(entry.pid)) return false;

    const ownerGone = Number.isInteger(entry.ownerPid) && !isPidAlive(entry.ownerPid);

    if (process.platform === 'win32') {
      const image = await readWindowsImageName(entry.pid);
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

    const info = await readUnixProcInfo(entry.pid);
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
  const reapOrphanedProcesses = async ({ log, keepPids = [] } = {}) => {
    await sweepDeadHolderClaims({ log });
    const records = await readAllEntries();
    if (records.length === 0) return { inspected: 0, reaped: 0 };

    let reaped = 0;
    for (const { entry, filePath } of records) {
      let drop = false;
      if (keepPids.includes(entry.pid)) continue;
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
        try {
          await fs.rm(filePath, { force: true });
        } catch {
          // best-effort
        }
      }
    }

    return { inspected: records.length, reaped };
  };

  return {
    registerManagedProcess,
    unregisterManagedProcess,
    reapOrphanedProcesses,
    // The validated reader exposed for read-only consumers (the
    // managed-servers read): entries only, never the file paths, never a
    // deletion, and a failed directory read propagates instead of posing
    // as an empty registry.
    readAllEntries: async () =>
      (await readAllEntries({ pruneInvalid: false, throwOnDirError: true })).map(({ entry }) => entry),
  };
};

const defaultRegistry = createManagedProcessRegistry();

export const registerManagedProcess = defaultRegistry.registerManagedProcess;
export const unregisterManagedProcess = defaultRegistry.unregisterManagedProcess;
export const reapOrphanedProcesses = defaultRegistry.reapOrphanedProcesses;
export const readManagedProcessEntries = defaultRegistry.readAllEntries;
