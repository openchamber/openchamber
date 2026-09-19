// The attach dialog page. Opened from the composer + menu (`ctx.item` is
// null) it is a picker; opened from the chip (`ctx.item` is the attached
// task) it shows that task's details instead of the whole list; opened from
// the "Create task from message" or "Summarize session" menu entries it gets
// that message or session as `ctx.item`.
import {
  connectHost,
  HostRequestError,
  isGuestMessageItem,
  isGuestSessionItem,
  type AttachIssueRequest,
  type GuestMessageItem,
  type GuestSessionItem,
  type JsonValue,
} from '@openchamber/sdk';
import { applyHostReady, mountBadge, mountButton, mountList, mountSearchField, mountSeparator, mountText } from '@openchamber/sdk/ui';
import { z } from 'zod';

import { TASKS, attachPayload, findTask, loadTasks, saveTask, type TaskData, type Task } from './tasks.ts';
import { createExample, element, feedback } from '../../shared.ts';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('no root');

// `data` is whatever this extension put on `attach`; the host stored it and
// handed it back untouched. Read it as our own shape, fall back to the list.
const taskDataSchema = z.object({ status: z.string(), comments: z.array(z.object({ author: z.string(), text: z.string() })), description: z.string().optional() });
const readTaskData = (data: JsonValue | undefined): TaskData | null => {
  const parsed = taskDataSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
};

const newPage = (): HTMLDivElement => {
  return createExample(root, { number: '02', title: 'Task Board', description: 'Keep the useful context close to the conversation.', api: 'Attach · Actions' }).content;
};

const renderDetails = (item: AttachIssueRequest): void => {
  const page = newPage();
  const task = findTask(item.id);
  const title = item.title;
  const url = item.url;
  const details: TaskData = readTaskData(item.data)
    ?? (task ? { status: task.status, comments: task.comments } : { status: 'Unknown', comments: [] });

  const head = document.createElement('div');
  head.style.display = 'flex';
  head.style.alignItems = 'center';
  head.style.gap = '8px';
  page.append(head);
  mountBadge(head, { label: item.id, tone: 'primary' });
  mountBadge(head, { label: details.status, tone: item.kind === 'pull' ? 'info' : 'warning' });

  page.append(element('h2', 'detail-title', title));
  if (details.description) {
    const brief = element('p', '', details.description); brief.style.whiteSpace = 'pre-wrap'; page.append(brief);
  }
  mountText(page, { text: `[${url}](${url})`, onOpenUrl: (href) => { void host.openUrl(href); } });
  mountSeparator(page);
  mountText(page, { text: details.comments.length ? 'Comments' : 'No comments yet.' });
  for (const comment of details.comments) {
    mountText(page, { text: `${comment.author}: ${comment.text}` });
  }

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  page.append(actions);
  mountButton(actions, {
    label: 'Send to chat',
    onClick: () => {
      void (async () => {
        try {
          await host.prompt({
            text: `${item.id}: ${title} (${details.status})\n${url}\n\nComments:\n${details.comments.map((c) => `- ${c.author}: ${c.text}`).join('\n') || '- none'}`,
            send: false,
          });
          await host.close();
        } catch (error) {
          const reason = error instanceof HostRequestError ? `${error.code}: ${error.message}` : String(error);
          await host.toast({ kind: 'error', message: `Send to chat failed. ${reason}` });
        }
      })();
    },
  });
  mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => void host.close() });
};

const renderPicker = (): void => {
  const page = newPage();
  mountText(page, { text: 'Pick a task to attach it to the chat.' });
  let query = '';
  let tasks = TASKS;
  const listRoot = document.createElement('div');
  const list = mountList(listRoot, {
    items: [],
    onSelect: (id) => {
      const task = tasks.find((entry) => entry.id === id);
      if (!task) return;
      void (async () => {
        try {
          await host.attach(attachPayload(task));
          await host.close();
        } catch (error) {
          const reason = error instanceof HostRequestError ? `${error.code}: ${error.message}` : String(error);
          await host.toast({ kind: 'error', message: `Attach failed. ${reason}` });
        }
      })();
    },
  });
  const paint = (): void => {
    list.update({
      items: tasks
        .filter((t) => t.title.toLowerCase().includes(query.toLowerCase()) || t.id.toLowerCase().includes(query.toLowerCase()))
        .map((t) => ({ id: t.id, leading: t.id, title: t.title, badge: { label: t.kind, tone: t.kind === 'pull' ? 'info' as const : 'success' as const } })),
    });
  };
  const search = mountSearchField(page, { value: query, placeholder: 'Search tasks', onChange: (v) => { query = v; search.update({ value: v }); paint(); } });
  page.append(listRoot);
  paint();
  const notice = feedback(page);
  void notice.run(async () => {
    const collection = await loadTasks(host); tasks = collection.tasks; paint();
    if (collection.failedKeys.length) notice.show('Some tasks are unavailable', 'Open the board and refresh to retry.', 'warning');
  });
};

const closeAfter = async (run: () => Promise<void>, label: string): Promise<void> => {
  try {
    await run();
    await host.close();
  } catch (error) {
    const reason = error instanceof HostRequestError ? `${error.code}: ${error.message}` : String(error);
    await host.toast({ kind: 'error', message: `${label} failed. ${reason}` });
  }
};

// "Create task from message": the assistant's text becomes a new task and
// is attached as a chip, so the next prompt can refer to it.
const renderMessageAction = (item: GuestMessageItem): void => {
  const page = newPage();
  const head = document.createElement('div');
  head.style.display = 'flex';
  head.style.gap = '8px';
  page.append(head);
  mountBadge(head, { label: item.role, tone: 'info' });
  mountBadge(head, { label: item.sessionTitle, tone: 'primary' });
  mountText(page, { text: 'Create a task from this message:' });
  const preview = document.createElement('pre');
  preview.style.whiteSpace = 'pre-wrap';
  preview.style.maxHeight = '40vh';
  preview.style.overflow = 'auto';
  preview.style.font = 'inherit';
  preview.textContent = item.text;
  page.append(preview);
  mountSeparator(page);
  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  page.append(actions);
  mountButton(actions, {
    label: 'Create',
    onClick: () => {
      const id = `TASK-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const title = item.text.split('\n').find((line) => line.trim())?.trim().slice(0, 80) ?? 'Task from message';
      void closeAfter(async () => {
        const task: Task = { id, title, url: `https://example.com/tasks/${id}`, kind: 'issue', status: 'Todo', comments: [], description: item.text.slice(0, 12000) };
        await saveTask(host, task);
        await host.toast({ kind: 'success', message: `Created ${id}: ${title}` });
        await host.attach(attachPayload(task));
      }, 'Create');
    },
  });
  mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => void host.close() });
};

// "Summarize session": `messages` is present because the manifest asked for
// `payload: ["messages"]` and the user granted `conversation`.
const renderSessionAction = (item: GuestSessionItem): void => {
  const page = newPage();
  mountBadge(page, { label: item.sessionTitle, tone: 'primary' });
  const messages = item.messages ?? [];
  mountText(page, {
    text: item.messages
      ? `${messages.length} message${messages.length === 1 ? '' : 's'}${item.truncated ? ' (oldest dropped to fit)' : ''}`
      : 'The conversation was not included.',
  });
  mountSeparator(page);
  for (const message of messages) {
    const line = message.text.replace(/\s+/g, ' ').slice(0, 200);
    const preview = document.createElement('p');
    preview.textContent = `${message.role}: ${line}${message.text.length > 200 ? '…' : ''}`;
    page.append(preview);
  }
  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  page.append(actions);
  mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => void host.close() });
};

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
});

let previousItem: string | undefined;
host.onItem((item) => {
  const serialized = JSON.stringify(item);
  if (serialized === previousItem) return;
  previousItem = serialized;
  if (isGuestMessageItem(item)) {
    renderMessageAction(item);
  } else if (isGuestSessionItem(item)) {
    renderSessionAction(item);
  } else if (item) {
    renderDetails(item);
  } else {
    renderPicker();
  }
});
