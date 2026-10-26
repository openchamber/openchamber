import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SHUTDOWN_GRACE_MS = 20_000;

// Job-control shells give foreground/background jobs their own process groups.
// Killing only -pty.pid misses those jobs; closing the PTY first sends SIGHUP.
const readProcesses = async () => {
  // Minimal server/container installations need not ship procps.
  if (process.platform === 'linux') {
    const processes = new Map();
    for (const entry of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let stat;
      try { stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
      const end = stat.lastIndexOf(')');
      const fields = stat.slice(end + 2).trim().split(/\s+/);
      const pid = Number(entry);
      processes.set(pid, { pid, parent: Number(fields[1]), group: Number(fields[2]), zombie: fields[0] === 'Z', started: fields[19], command: stat.slice(stat.indexOf('(') + 1, end) });
    }
    return processes;
  }
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=,comm='], { timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
  return new Map(stdout.trim().split('\n').map(line => {
    const fields = line.trim().split(/\s+/);
    return [Number(fields[0]), { pid: Number(fields[0]), parent: Number(fields[1]), group: Number(fields[2]), zombie: fields[3].startsWith('Z'), started: fields.slice(4, 9).join(' '), command: fields.slice(9).join(' ') }];
  }));
};

const signal = (pid, name) => {
  try { process.kill(pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
};

export async function shutdownTerminalProcesses(terminals, { graceMs = SHUTDOWN_GRACE_MS } = {}) {
  if (!terminals.length) return;
  // ConPTY has no POSIX signal protocol. Its backend owns tree teardown.
  if (process.platform === 'win32') {
    for (const { process: pty } of terminals) {
      try { pty.kill(); } catch { /* already gone; other terminals still need cleanup */ }
    }
    return;
  }

  const deadline = Date.now() + graceMs;
  const owned = new Map();
  const shells = new Map();
  try {
    let snapshot = await readProcesses();
    for (const terminal of terminals) {
      const current = snapshot.get(terminal.process.pid);
      if (!current || current.zombie) continue;
      owned.set(current.pid, { ...current, terminal: current.pid });
      // An exec'ed server occupies the shell PID, but must get the same grace
      // as a child. Only an actual shell is held open until its jobs finish.
      if (path.basename(current.command) === path.basename(terminal.shellExecutable)) shells.set(current.pid, terminal.process);
    }
    const signalled = new Set();
    while (owned.size) {
      for (const [pid, previous] of owned) {
        const current = snapshot.get(pid);
        if (!current || current.zombie || current.started !== previous.started) { owned.delete(pid); shells.delete(pid); }
        else if (current.command !== previous.command) shells.delete(pid);
      }
      // Retain descendants before signalling anything, including separate job
      // groups and children still cleaning up after their parent has exited.
      let added;
      do {
        added = false;
        for (const current of snapshot.values()) {
          if (!current.zombie && !owned.has(current.pid) && owned.has(current.parent)) {
            owned.set(current.pid, { ...current, terminal: owned.get(current.parent).terminal });
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
    // A failed process-table read is not evidence that the jobs exited.
    console.warn('Terminal graceful shutdown failed; forcing owned PTYs closed:', error.message);
    for (const pid of owned.keys()) { try { signal(pid, 'SIGKILL'); } catch { /* best effort */ } }
    for (const { process: pty } of terminals) {
      try { pty.kill('SIGKILL'); } catch { /* continue with the remaining PTYs */ }
    }
  }
}
