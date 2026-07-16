import { AsyncLocalStorage } from 'node:async_hooks';

type GitExecutionScope = {
  readOnly: boolean;
};

const gitExecutionScope = new AsyncLocalStorage<GitExecutionScope>();

export const runWithGitExecutionScope = <T>(
  readOnly: boolean,
  task: () => Promise<T> | T,
): Promise<T> => gitExecutionScope.run({ readOnly }, () => Promise.resolve().then(task));

export const getGitExecutionEnv = (): NodeJS.ProcessEnv => (
  gitExecutionScope.getStore()?.readOnly
    ? { GIT_OPTIONAL_LOCKS: '0' }
    : {}
);
