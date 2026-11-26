import { execFile } from 'node:child_process';
import path from 'node:path';

const systemBinary = (name: string) => path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);

const run = (command: string, args: string[], timeout: number) => new Promise<string>((resolve) => {
  try {
    execFile(command, args, { encoding: 'utf8', maxBuffer: Infinity, timeout, windowsHide: true }, (error, stdout) => {
      resolve(error ? '' : stdout);
    });
  } catch {
    resolve('');
  }
});

const LISTENER = /^\s*TCP\s+\S+:(\d+)\s+\S+:0\s+\S.*?\s+(\d+)\s*$/i;

const stopListeners = async (port: number) => {
  const pids = new Set<number>();
  for (const line of (await run(systemBinary('NETSTAT.EXE'), ['-ano'], 5000)).split(/\r?\n/)) {
    const listener = LISTENER.exec(line);
    const pid = Number(listener?.[2]);
    if (Number(listener?.[1]) === port && pid && pid !== process.pid) pids.add(pid);
  }
  for (const pid of pids) await run(systemBinary('taskkill.exe'), ['/PID', String(pid), '/F'], 3000);
};

const running = new Map<number, Promise<void>>();

export const stopWindowsProcessesListeningOnPort = (port: number) => {
  const current = running.get(port);
  if (current) return current;
  const stopping = stopListeners(port).finally(() => running.delete(port));
  running.set(port, stopping);
  return stopping;
};
