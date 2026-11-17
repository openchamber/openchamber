import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SHUTDOWN_GRACE_MS = 20_000;

export interface TerminalShutdownProcess {
  pid: number;
  kill: (signal?: NodeJS.Signals) => void;
}

export interface TerminalShutdownTarget {
  process: TerminalShutdownProcess;
  shellExecutable: string;
}

export interface TerminalShutdownOptions {
  graceMs?: number;
}

interface ProcessEntry {
  pid: number;
  parent: number;
  group: number;
  zombie: boolean;
  started: string | undefined;
  command: string;
}

interface OwnedProcess extends ProcessEntry {
  terminal: number;
}

const hasProcessErrorCode = (value: unknown): value is Error & { code: string } => value instanceof Error && 'code' in value && typeof value.code === 'string';

const readProcesses = async () => {
  if (process.platform === 'linux') {
    const processes = new Map<number, ProcessEntry>();
    for (const entry of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let stat;
      try { stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8'); }
      catch (error) { if (hasProcessErrorCode(error) && (error.code === 'ENOENT' || error.code === 'ESRCH')) continue; throw error; }
      const end = stat.lastIndexOf(')');
      const fields = stat.slice(end + 2).trim().split(/\s+/);
      const pid = Number(entry);
      processes.set(pid, { pid, parent: Number(fields[1]), group: Number(fields[2]), zombie: fields[0] === 'Z', started: fields[19], command: stat.slice(stat.indexOf('(') + 1, end) });
    }
    return processes;
  }
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=,comm='], { timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
  return new Map<number, ProcessEntry>(stdout.trim().split('\n').map(line => {
    const fields = line.trim().split(/\s+/);
    const status = fields[3];
    if (status === undefined) throw new TypeError("Cannot read properties of undefined (reading 'startsWith')");
    return [Number(fields[0]), { pid: Number(fields[0]), parent: Number(fields[1]), group: Number(fields[2]), zombie: status.startsWith('Z'), started: fields.slice(4, 9).join(' '), command: fields.slice(9).join(' ') }];
  }));
};

const signal = (pid: number, name: NodeJS.Signals) => {
  try { process.kill(pid, name); } catch (error) { if (!hasProcessErrorCode(error) || error.code !== 'ESRCH') throw error; }
};

export async function shutdownTerminalProcesses(terminals: TerminalShutdownTarget[], { graceMs = SHUTDOWN_GRACE_MS }: TerminalShutdownOptions = {}) {
  if (!terminals.length) return;
  if (process.platform === 'win32') {
    for (const { process: pty } of terminals) {
      try { pty.kill(); } catch { continue; }
    }
    return;
  }

  const deadline = Date.now() + graceMs;
  const owned = new Map<number, OwnedProcess>();
  const shells = new Map<number, TerminalShutdownProcess>();
  try {
    let snapshot = await readProcesses();
    for (const terminal of terminals) {
      const current = snapshot.get(terminal.process.pid);
      if (!current || current.zombie) continue;
      owned.set(current.pid, { ...current, terminal: current.pid });
      if (path.basename(current.command) === path.basename(terminal.shellExecutable)) shells.set(current.pid, terminal.process);
    }
    const signalled = new Set<number>();
    while (owned.size) {
      for (const [pid, previous] of owned) {
        const current = snapshot.get(pid);
        if (!current || current.zombie || current.started !== previous.started) { owned.delete(pid); shells.delete(pid); }
        else if (current.command !== previous.command) shells.delete(pid);
      }
      let added;
      do {
        added = false;
        for (const current of snapshot.values()) {
          const parent = owned.get(current.parent);
          if (!current.zombie && !owned.has(current.pid) && parent) {
            owned.set(current.pid, { ...current, terminal: parent.terminal });
            added = true;
          }
        }
      } while (added);
      for (const pid of owned.keys()) {
        if (!shells.has(pid) && !signalled.has(pid)) { signal(pid, 'SIGTERM'); signalled.add(pid); }
      }
      for (const [pid, pty] of shells) {
        const hasJobs = [...owned.values()].some(current => current.terminal === pid && current.pid !== pid);
        if (!hasJobs && !signalled.has(pid)) { pty.kill('SIGHUP'); signalled.add(pid); }
      }
      if (!owned.size) return;
      if (Date.now() >= deadline) {
        for (const current of owned.values()) {
          if (current.group === current.pid) signal(-current.group, 'SIGKILL');
          signal(current.pid, 'SIGKILL');
        }
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
      snapshot = await readProcesses();
    }
  } catch (error) {
    console.warn('Terminal graceful shutdown failed; forcing owned PTYs closed:', error instanceof Error ? error.message : undefined);
    for (const pid of owned.keys()) { try { signal(pid, 'SIGKILL'); } catch { continue; } }
    for (const { process: pty } of terminals) {
      try { pty.kill('SIGKILL'); } catch { continue; }
    }
  }
}
