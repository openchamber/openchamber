export const PROVIDER = 'tasks-demo';

export type TaskComment = { author: string; text: string };

export type Task = {
  id: string;
  title: string;
  url: string;
  kind: 'issue' | 'pull';
  status: string;
  comments: TaskComment[];
};

/** What the task carries back through `attach` → `ready.item.data`. */
export type TaskData = { status: string; comments: TaskComment[] };

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
  text: `Work on ${task.id}: ${task.title}\n${task.url}`,
  data: { status: task.status, comments: task.comments } satisfies TaskData,
});
