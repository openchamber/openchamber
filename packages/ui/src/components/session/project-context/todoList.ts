import type { ProjectTodoItem } from '@/lib/projectContextApi';

export const sortTodosWithCompletedLast = (items: ProjectTodoItem[]): ProjectTodoItem[] => [
  ...items.filter((todo) => !todo.completed),
  ...items.filter((todo) => todo.completed),
];

export const insertTodoBeforeCompleted = (items: ProjectTodoItem[], item: ProjectTodoItem): ProjectTodoItem[] => {
  const firstCompletedIndex = items.findIndex((todo) => todo.completed);
  if (firstCompletedIndex === -1) {
    return [...items, item];
  }
  return [...items.slice(0, firstCompletedIndex), item, ...items.slice(firstCompletedIndex)];
};

export const withTodoCompleted = (items: ProjectTodoItem[], id: string, completed: boolean): ProjectTodoItem[] | null => {
  const todo = items.find((item) => item.id === id);
  if (!todo || todo.completed === completed) return null;
  const remaining = items.filter((item) => item.id !== id);
  const updated = { ...todo, completed };
  return completed ? [...remaining, updated] : insertTodoBeforeCompleted(remaining, updated);
};

export const unfinishedDependencies = (todo: ProjectTodoItem, byId: ReadonlyMap<string, ProjectTodoItem>): ProjectTodoItem[] => (
  (todo.dependsOn ?? [])
    .map((id) => byId.get(id))
    .filter((dependency): dependency is ProjectTodoItem => Boolean(dependency && !dependency.completed))
);
