import { connectHost, HostRequestError } from '@openchamber/sdk';
import { applyHostReady, mountBanner, mountButton, mountCheckbox, mountList, mountSearchField, mountText } from '@openchamber/sdk/ui';

import { TASKS, attachPayload, findTask, openTasks } from './tasks.ts';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('no root');

const describe = (error: unknown): string => (
  error instanceof HostRequestError ? `${error.code}: ${error.message}` : String(error)
);

// `/task DEMO-2` in the composer lands here. The host mounts this page
// off-screen when the panel is closed, so keep the handler free of UI.
// Returning null tells the user nothing matched; throwing shows the message.
host.onResolve(({ args }) => {
  const id = args.trim().toUpperCase();
  if (!id) throw new Error('Give a task id, e.g. /task DEMO-2');
  const task = findTask(id);
  return task ? attachPayload(task) : null;
});

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  // The rail icon shows how many tasks are open until the user opens the panel.
  void host.setBadge(openTasks().length).catch(() => undefined);
  while (root.firstChild) root.removeChild(root.firstChild);
  const page = document.createElement('div');
  page.style.padding = '12px';
  page.style.display = 'flex';
  page.style.flexDirection = 'column';
  page.style.gap = '10px';
  root.append(page);

  const intro = mountText(page, {
    text: ctx.surface === 'dialog'
      ? 'Pick a task to attach it to the chat, or start a session from it.'
      : 'Pick a task, then use the buttons. Decline the approval dialog to see NOT_GRANTED.',
  });
  void intro;

  let query = '';
  let selected: string | null = null;
  let worktree = false;
  const listRoot = document.createElement('div');
  const list = mountList(listRoot, {
    items: [],
    onSelect: (id) => { selected = id; paint(); },
  });
  const paint = (): void => {
    list.update({
      items: TASKS
        .filter((t) => t.title.toLowerCase().includes(query.toLowerCase()) || t.id.toLowerCase().includes(query.toLowerCase()))
        .map((t) => ({ id: t.id, leading: t.id, title: t.title, badge: { label: t.kind, tone: t.kind === 'pull' ? 'info' as const : 'success' as const } })),
      selectedId: selected,
    });
    actions.style.opacity = selected ? '1' : '0.5';
    actions.style.pointerEvents = selected ? 'auto' : 'none';
  };
  mountSearchField(page, { value: query, placeholder: 'Search tasks', onChange: (v) => { query = v; paint(); } });
  page.append(listRoot);

  const current = (): (typeof TASKS)[number] => {
    const task = selected ? findTask(selected) : null;
    if (!task) throw new Error('nothing selected');
    return task;
  };
  const payload = () => attachPayload(current());
  const report = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      const result = await run();
      await host.toast({ kind: 'success', message: `${label}: ${result === undefined ? 'ok' : JSON.stringify(result)}` });
    } catch (error) {
      await host.toast({ kind: 'error', message: `${label} failed. ${describe(error)}` });
    }
  };

  const actions = document.createElement('div');
  actions.style.display = 'flex'; actions.style.flexWrap = 'wrap'; actions.style.gap = '8px';
  page.append(actions);
  mountButton(actions, { label: 'Attach', onClick: () => void report('attach', () => host.attach(payload())) });
  mountButton(actions, { label: 'Link to session', variant: 'secondary', onClick: () => void report('sessionLink', () => host.sessionLink(payload())) });
  mountButton(actions, { label: 'Start session', variant: 'outline', onClick: () => void report('startSession', () => host.startSession({ ...payload(), worktree })) });
  mountButton(actions, { label: 'Compose prompt', variant: 'ghost', onClick: () => void report('prompt (compose)', () => host.prompt({ text: `Please look at ${current().id}: ${current().title}` })) });
  mountButton(actions, { label: 'Send prompt', variant: 'destructive', onClick: () => void report('prompt (send)', () => host.prompt({ text: `Summarize what ${current().id} (${current().title}) would need.`, send: true })) });
  if (ctx.surface === 'dialog') {
    mountButton(actions, { label: 'Close', variant: 'ghost', size: 'sm', onClick: () => void host.close() });
  }
  mountCheckbox(page, { label: 'Start sessions on a new worktree', checked: worktree, onChange: (v) => { worktree = v; } });
  mountBanner(page, { tone: 'info', title: 'What this tests', body: 'attach and sessionLink need no capability. startSession needs "sessions" (and "prompt" because it sends text). Send prompt needs "prompt". Type /task DEMO-2 in the chat to attach through a command; the rail badge counts open tasks; "Create task from message" and "Summarize session" are in the message and session menus.' });
  paint();
});
