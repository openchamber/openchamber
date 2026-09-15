import { AsyncLocalStorage } from 'node:async_hooks';

import { GIT_READ_ONLY_ENV } from './execution-coordinator.js';

const gitExecutionScope = new AsyncLocalStorage();

export const runWithGitExecutionScope = (readOnly, task) => (
  gitExecutionScope.run({ readOnly }, () => Promise.resolve().then(task))
);

export const getGitExecutionEnv = () => (
  gitExecutionScope.getStore()?.readOnly ? GIT_READ_ONLY_ENV : {}
);
