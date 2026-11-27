import { spawn } from 'node:child_process';
import os from 'node:os';
import readline from 'node:readline';

const PROBE_THREADS = '256';

const PROBE_PROGRAM = `
const fs = require('fs');
const end = () => process.kill(process.pid, 'SIGKILL');
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, path } = JSON.parse(line);
  const answer = (error) => process.stdout.write(JSON.stringify({ id, code: error ? error.code || 'UNKNOWN' : null }) + '\\n');
  fs.promises.opendir(path, { bufferSize: 1 }).then(async (directory) => {
    try { await directory.read(); } finally { await directory.close(); }
  }).then(() => answer(null), (error) => (error.code === 'ENOTDIR' ? fs.stat(path, answer) : answer(error)));
}).on('close', end);
process.stdout.on('error', end);
`;

interface ProbeAnswer {
  id: number;
  code: string | null;
}

const isProbeAnswer = (value: unknown): value is ProbeAnswer => (
  typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'number'
  && 'code' in value && (value.code === null || typeof value.code === 'string')
);

export interface ProbeProcess {
  touch: (path: string) => Promise<string | null | undefined>;
  stop: () => void;
}

export type StartProbeProcess = (onExit: (failed: boolean) => void) => ProbeProcess;

export const startProbeProcess: StartProbeProcess = (onExit) => {
  const pending = new Map<number, (code: string | null | undefined) => void>();
  let nextId = 1;
  let stopped = false;
  const child = spawn(process.execPath, ['-e', PROBE_PROGRAM], {
    cwd: os.tmpdir(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', UV_THREADPOOL_SIZE: PROBE_THREADS, NODE_OPTIONS: '' },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  child.unref();
  const killWithParent = () => { child.kill('SIGKILL'); };
  process.once('exit', killWithParent);

  const finish = (failed: boolean) => {
    if (stopped) return;
    stopped = true;
    process.off('exit', killWithParent);
    for (const resolve of pending.values()) resolve(undefined);
    pending.clear();
    onExit(failed);
  };
  child.on('error', () => finish(true));
  child.on('exit', () => finish(true));
  child.stdin.on('error', () => {});
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const answer: unknown = JSON.parse(line);
    if (!isProbeAnswer(answer)) return;
    pending.get(answer.id)?.(answer.code);
    pending.delete(answer.id);
  });

  return {
    touch: (path) => new Promise((resolve) => {
      if (stopped) {
        resolve(undefined);
        return;
      }
      const id = nextId;
      nextId += 1;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, path })}\n`);
    }),
    stop: () => {
      child.kill('SIGKILL');
      finish(false);
    },
  };
};
