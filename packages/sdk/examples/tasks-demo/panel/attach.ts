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

import { PROVIDER, TASKS, attachPayload, findTask, type TaskComment, type TaskData } from './tasks.ts';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('no root');

// `data` is whatever this extension put on `attach`; the host stored it and
// handed it back untouched. Read it as our own shape, fall back to the list.
const readTaskData = (data: JsonValue | undefined): TaskData | null => {
  if (!data || Array.isArray(data) || Object(data) !== data) return null;
  const record = data as { [key: string]: JsonValue };
  const status = record.status;
  const comments = record.comments;
  if (String(status) !== status || !Array.isArray(comments)) return null;
  const parsed: TaskComment[] = [];
  for (const entry of comments) {
    if (!entry || Array.isArray(entry) || Object(entry) !== entry) return null;
    const { author, text } = entry as { [key: string]: JsonValue };
    if (String(author) !== author || String(text) !== text) return null;
    parsed.push({ author, text });
  }
  return { status, comments: parsed };
};

const newPage = (): HTMLDivElement => {
  while (root.firstChild) root.removeChild(root.firstChild);
  const page = document.createElement('div');
  page.style.padding = '12px';
  page.style.display = 'flex';
  page.style.flexDirection = 'column';
  page.style.gap = '10px';
  root.append(page);
  return page;
};

const renderDetails = (item: AttachIssueRequest): void => {
  const page = newPage();
  const task = findTask(item.id);
  const title = task?.title ?? item.title;
  const url = task?.url ?? item.url;
  const details: TaskData = readTaskData(item.data)
    ?? (task ? { status: task.status, comments: task.comments } : { status: 'Unknown', comments: [] });

  const head = document.createElement('div');
  head.style.display = 'flex';
  head.style.alignItems = 'center';
  head.style.gap = '8px';
  page.append(head);
  mountBadge(head, { label: item.id, tone: 'primary' });
  mountBadge(head, { label: details.status, tone: item.kind === 'pull' ? 'info' : 'warning' });

  mountText(page, { text: title });
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
  const listRoot = document.createElement('div');
  const list = mountList(listRoot, {
    items: [],
    onSelect: (id) => {
      const task = findTask(id);
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
      items: TASKS
        .filter((t) => t.title.toLowerCase().includes(query.toLowerCase()) || t.id.toLowerCase().includes(query.toLowerCase()))
        .map((t) => ({ id: t.id, leading: t.id, title: t.title, badge: { label: t.kind, tone: t.kind === 'pull' ? 'info' as const : 'success' as const } })),
    });
  };
  mountSearchField(page, { value: query, placeholder: 'Search tasks', onChange: (v) => { query = v; paint(); } });
  page.append(listRoot);
  paint();
};

const closeAfter = async (run: () => Promise<unknown>, label: string): Promise<void> => {
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
      const id = `DEMO-${TASKS.length + 1}`;
      const title = item.text.split('\n').find((line) => line.trim())?.trim().slice(0, 80) ?? 'Task from message';
      void closeAfter(async () => {
        await host.toast({ kind: 'success', message: `Created ${id}: ${title}` });
        await host.attach({
          providerId: PROVIDER,
          id,
          title,
          url: `https://example.com/tasks/${id}`,
          text: `Task ${id} was created from message ${item.messageId} in "${item.sessionTitle}":\n${item.text}`,
        });
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
    mountText(page, { text: `${message.role}: ${line}${message.text.length > 200 ? '…' : ''}` });
  }
  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  page.append(actions);
  mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => void host.close() });
};

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  if (isGuestMessageItem(ctx.item)) {
    renderMessageAction(ctx.item);
  } else if (isGuestSessionItem(ctx.item)) {
    renderSessionAction(ctx.item);
  } else if (ctx.item) {
    renderDetails(ctx.item);
  } else {
    renderPicker();
  }
});
