import { runtimeFetch } from '@/lib/runtime-fetch';

export class MultiRepoTaskError extends Error {
  readonly problems: string[];

  constructor(message: string, problems: string[]) {
    super(message);
    this.name = 'MultiRepoTaskError';
    this.problems = problems;
  }
}

interface MultiRepoTaskInspection {
  path: string;
  branch: string;
  repositories: Array<{ name: string; uncommitted: boolean; unpushedCommits: number; ignored: string[] }>;
  problems: string[];
}

const readJson = async <T>(response: Response): Promise<T> => {
  // SAFETY: the routes are ours (`/api/projects/multi-repo-tasks/*`): every answer is JSON,
  // a failure carries `{ error, problems }`, a success the shape the caller names.
  const body = await response.json() as T & { error?: string; problems?: string[] };
  if (!response.ok) {
    throw new MultiRepoTaskError(body.error ?? response.statusText, body.problems ?? []);
  }
  return body;
};

const postJson = (url: string, body: unknown) => runtimeFetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify(body),
});

export const listTaskRepositories = async (reposDir: string): Promise<string[]> => {
  const data = await readJson<{ repositories: string[] }>(
    await runtimeFetch('/api/projects/multi-repo-tasks/repositories', { query: { reposDir } }),
  );
  return data.repositories;
};

export const createMultiRepoTask = async (input: {
  reposDir: string;
  tasksDir: string;
  name: string;
  branchPrefix: string;
  repositories: string[];
}): Promise<{ path: string; branch: string }> => readJson(await postJson('/api/projects/multi-repo-tasks', input));

export const inspectMultiRepoTask = async (path: string): Promise<MultiRepoTaskInspection | null> => {
  const response = await runtimeFetch('/api/projects/multi-repo-tasks/inspect', { query: { path } });
  if (response.status === 404) return null;
  const data = await readJson<{ task: MultiRepoTaskInspection | null }>(response);
  return data.task;
};

export const removeMultiRepoTask = async (path: string): Promise<void> => {
  await readJson<{ removed: string[] }>(await postJson('/api/projects/multi-repo-tasks/remove', { path }));
};
