import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { attachPayload, loadTasks } from './tasks.ts';
import { mountBoard } from './board.ts';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing root');
host.onResolve(async ({ args }) => {
  const id = args.trim().toUpperCase();
  if (!id) throw new Error('Give a task id, for example /task DEMO-2');
  const collection = await loadTasks(host);
  if (collection.failedKeys.includes(`task:${id}`)) throw new Error('This task could not be loaded. Refresh the board to retry.');
  const task = collection.tasks.find((entry) => entry.id === id);
  return task ? attachPayload(task) : null;
});
let dispose: (() => void) | undefined;
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  dispose ??= mountBoard(host, root);
});
window.addEventListener('pagehide', () => { dispose?.(); host.dispose(); });
