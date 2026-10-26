import { fork } from 'node:child_process';
import { once } from 'node:events';

export async function storageProcess(kind, filePath) {
  const child = fork(new URL('./storage-process.fixture.js', import.meta.url), [kind, filePath], {
    execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const events = [];
  const pending = new Map();
  let sequence = 0;
  child.on('message', (message) => {
    events.push(message);
    if (Object.hasOwn(message, 'ok')) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  await once(child, 'message');
  return {
    events,
    call(method, args = [], options = {}) {
      const id = String(++sequence);
      const result = new Promise((resolve) => pending.set(id, resolve));
      child.send({ id, method, args, ...options });
      return { id, result };
    },
    release(id) { child.send({ release: id }); },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    },
  };
}
