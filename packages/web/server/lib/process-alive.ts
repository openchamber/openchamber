import { readFileSync } from 'node:fs';

// Whether `pid` names a process that is still running.
//
// Signal 0 alone is not enough: it also succeeds for a zombie — a process
// that has exited but whose parent has not collected it yet. A zombie runs
// nothing and holds nothing but a process-table entry, and where the init
// does not reap adopted orphans (the fleet build container is one such
// place) a killed grandchild can stay a zombie forever, so a poll on
// signal 0 never sees it die (#2495). The terminal shutdown code already
// treats state Z as dead for the same reason (lib/terminal/shutdown.ts);
// this is that rule for a single pid.
//
// On Linux the state comes from /proc/<pid>/stat. Elsewhere signal 0 is
// the whole answer.
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== 'linux') return true;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return false; // Gone between the signal and the read.
  }
  // The command name in parentheses may itself contain spaces or parens;
  // the state letter is the first field after the closing paren.
  const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
  return state !== 'Z' && state !== 'X';
};
