import { asNonEmptyString, hasProperties } from '../shared/object-guards.js';
import type { ScheduledTaskInput } from './contracts.js';

export const MAX_TASK_NAME_LENGTH = 80;
export const MAX_TASK_PROMPT_LENGTH = 20_000;

export const assertTaskTextWithinLimits = (task: ScheduledTaskInput) => {
  const execution = task?.execution;
  for (const [field, text, max] of [
    ['task.name', asNonEmptyString(task?.name), MAX_TASK_NAME_LENGTH],
    ['execution.prompt', asNonEmptyString(hasProperties(execution) ? execution.prompt : undefined), MAX_TASK_PROMPT_LENGTH],
  ] as const) {
    if (text && text.length > max) {
      throw new Error(`${field} is invalid: at most ${max} characters, got ${text.length}`);
    }
  }
  return task;
};
