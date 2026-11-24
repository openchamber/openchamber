import { fork } from 'node:child_process';
import { once } from 'node:events';
import type { Serializable } from 'node:child_process';

const isStorageReply = (value: Serializable): value is Serializable & { id?: unknown } => Object.hasOwn(value, 'ok');

export async function storageProcess(kind: string, filePath: string) {
  const child = fork(new URL('./storage-process.fixture.ts', import.meta.url), [kind, filePath], {
    execArgv: ['--import', new URL('../../../scripts/register-server-sources.mjs', import.meta.url).href], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const events: Serializable[] = [];
  const pending = new Map<unknown, (message: Serializable) => void>();
  let sequence = 0;
  child.on('message', (message: Serializable) => {
    events.push(message);
    if (isStorageReply(message)) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  await once(child, 'message');
  return {
    events,
    call(method: string, args: Serializable[] = [], options: { hold?: boolean; outcome?: string } = {}) {
      const id = String(++sequence);
      const result = new Promise<Serializable>((resolve) => pending.set(id, resolve));
      child.send({ id, method, args, ...options });
      return { id, result };
    },
    release(id: string) { child.send({ release: id }); },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    },
  };
}
