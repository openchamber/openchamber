import { fork } from 'node:child_process';
import { once } from 'node:events';
import type { JsonObject, JsonValue } from '../shared/json-values.js';

export async function gitStorageProcess(kind: string, filePath: string) {
  const child = fork(new URL('./storage-process.fixture.ts', import.meta.url), [kind, filePath], {
    execArgv: ['--import', new URL('../../../scripts/register-server-sources.mjs', import.meta.url).href], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const events: JsonObject[] = [];
  const pending = new Map<JsonValue | undefined, (message: JsonObject) => void>();
  let sequence = 0;
  child.on('message', (message: JsonObject) => {
    events.push(message);
    if (!Object.hasOwn(message, 'ok')) return;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  await once(child, 'message');
  return {
    events,
    call(method: string, args: (JsonValue | undefined)[] = []) {
      const id = String(++sequence);
      const result = new Promise<JsonObject>((resolve) => pending.set(id, resolve));
      child.send({ id, method, args });
      return { id, result };
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    },
  };
}
