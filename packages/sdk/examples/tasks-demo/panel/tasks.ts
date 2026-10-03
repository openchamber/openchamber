import { z } from 'zod';
import type { HostClient } from '@openchamber/sdk';

export const PROVIDER = 'tasks-demo';

export type TaskComment = { author: string; text: string };

export type Task = {
  id: string;
  title: string;
  url: string;
  kind: 'issue' | 'pull';
  status: string;
  comments: TaskComment[];
  description?: string;
  sessions?: Array<{ id: string; projectId: string }>;
  deleted?: boolean;
};

const taskSchema = z.object({
  id: z.string().min(1).max(128), title: z.string().trim().min(1).max(160), url: z.string().url(),
  kind: z.enum(['issue', 'pull']), status: z.enum(['Todo', 'In progress', 'In review', 'Done']),
  comments: z.array(z.object({ author: z.string(), text: z.string() })),
  description: z.string().max(12000).optional(),
  sessions: z.array(z.object({ id: z.string(), projectId: z.string() })).optional(),
  deleted: z.boolean().optional(),
});

type TaskCollection = { tasks: Task[]; failedKeys: string[] };
export const loadTasks = async (host: Pick<HostClient, 'storage'>): Promise<TaskCollection> => {
  const keys = (await host.storage.keys()).filter((key) => key.startsWith('task:'));
  const merged = new Map(TASKS.map((task) => [task.id, { ...task, comments: [...task.comments] }]));
  const failedKeys: string[] = [];
  // Keep reads bounded when an author grows the sample into a larger board.
  for (let offset = 0; offset < keys.length; offset += 16) {
    await Promise.all(keys.slice(offset, offset + 16).map(async (key) => {
      try {
        const task = taskSchema.parse(await host.storage.get(key));
        if (key !== `task:${task.id}`) throw new Error('Task identity does not match its storage key.');
        merged.set(task.id, task);
      } catch {
        failedKeys.push(key);
        merged.delete(key.slice('task:'.length));
      }
    }));
  }
  return { tasks: [...merged.values()].filter((task) => !task.deleted), failedKeys };
};

export const saveTask = async (host: Pick<HostClient, 'storage'>, task: Task) => {
  const parsed = taskSchema.parse(task);
  await host.storage.set(`task:${parsed.id}`, { ...parsed, description: parsed.description ?? '', sessions: parsed.sessions ?? [], deleted: parsed.deleted ?? false });
};

/** What the task carries back through `attach` → `ready.item.data`. */
export type TaskData = { status: string; comments: TaskComment[]; description?: string };

export const TASKS: Task[] = [
  {
    id: 'DEMO-1', title: 'Fix the login redirect loop', url: 'https://example.com/tasks/DEMO-1', kind: 'issue', status: 'In progress',
    comments: [
      { author: 'mara', text: 'Reproduced on staging, happens after the second login.' },
      { author: 'dev-bot', text: 'Linked branch fix/login-loop was pushed 2h ago.' },
    ],
  },
  { id: 'DEMO-2', title: 'Add dark mode to settings', url: 'https://example.com/tasks/DEMO-2', kind: 'issue', status: 'Todo', comments: [] },
  {
    id: 'DEMO-3', title: 'Bump dependencies', url: 'https://example.com/tasks/DEMO-3', kind: 'pull', status: 'In review',
    comments: [{ author: 'ci', text: 'All checks passed.' }],
  },
  { id: 'DEMO-4', title: 'Write release notes for 2.0', url: 'https://example.com/tasks/DEMO-4', kind: 'issue', status: 'Todo', comments: [] },
];

export const findTask = (id: string): Task | null => TASKS.find((task) => task.id === id) ?? null;

/** What the rail badge counts: everything that is not done. */
export const openTasks = (): Task[] => TASKS.filter((task) => task.status !== 'Done');

export const attachPayload = (task: Task) => ({
  providerId: PROVIDER,
  id: task.id,
  title: task.title,
  url: task.url,
  kind: task.kind,
  text: `Work on ${task.id}: ${task.title}\n${task.description ?? ''}\n${task.url}`,
  data: { status: task.status, comments: task.comments, description: task.description ?? '' } satisfies TaskData,
});
