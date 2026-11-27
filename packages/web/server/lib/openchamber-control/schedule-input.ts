import { asNonEmptyString, isBoolean } from '../shared/guards.js';
import { OpenChamberControlError } from './error.js';
import type { ControlInput } from './contracts.js';

interface TaskExecution {
  prompt: string;
  providerID?: string;
  modelID?: string;
  agent?: string;
  variant?: string;
  useDefaults?: boolean;
  goalEnabled?: boolean;
  goalTokenBudget?: number;
}

type TaskSchedule =
  | { kind: 'daily'; times: string[]; timezone?: string }
  | { kind: 'weekly'; times: string[]; weekdays: number[]; timezone?: string }
  | { kind: 'once'; date: string; time: string; timezone?: string }
  | { kind: 'cron'; cron: string | null; timezone?: string };

export interface ControlTask {
  id?: string;
  loopFile?: string;
  name: string;
  enabled: boolean;
  schedule: TaskSchedule;
  execution: TaskExecution;
  targetSessionId?: unknown;
  runInWorktree?: unknown;
  cleanupWorktree?: unknown;
  baseBranch?: string | null;
}

const hasText = (value: unknown): value is string => Boolean(asNonEmptyString(value));
const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);

const parseModel = (value: ControlInput['model']) => {
  const model = asNonEmptyString(value);
  if (!model) throw new OpenChamberControlError('model is required', 400);
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0 || slashIndex === model.length - 1) {
    throw new OpenChamberControlError('model must be in provider/model format', 400);
  }
  return { providerID: model.slice(0, slashIndex), modelID: model.slice(slashIndex + 1) };
};

const parseWeekdays = (value: ControlInput['weekly']) => {
  const raw = asNonEmptyString(value);
  if (!raw) throw new OpenChamberControlError('weekly is required', 400);
  const weekdays = raw.split(',').map((entry) => Number.parseInt(entry.trim(), 10));
  if (weekdays.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 6)) {
    throw new OpenChamberControlError('weekly must contain weekdays from 0 to 6', 400);
  }
  return Array.from(new Set(weekdays)).sort((a, b) => a - b);
};

const buildSchedule = (input: ControlInput): TaskSchedule => {
  const daily = asNonEmptyString(input.daily);
  const weekly = asNonEmptyString(input.weekly);
  const once = asNonEmptyString(input.once);
  const cron = asNonEmptyString(input.cron);
  const selectors = [daily, weekly, once, cron].filter(Boolean);
  if (selectors.length !== 1) {
    throw new OpenChamberControlError('Provide exactly one of daily, weekly, once, or cron', 400);
  }
  const timezone = asNonEmptyString(input.timezone);
  if (daily) {
    const schedule: TaskSchedule = { kind: 'daily', times: [daily] };
    if (timezone) schedule.timezone = timezone;
    return schedule;
  }
  if (weekly) {
    const time = asNonEmptyString(input.time);
    if (!time) throw new OpenChamberControlError('time is required with weekly', 400);
    const schedule: TaskSchedule = { kind: 'weekly', weekdays: parseWeekdays(weekly), times: [time] };
    if (timezone) schedule.timezone = timezone;
    return schedule;
  }
  if (once) {
    const time = asNonEmptyString(input.time);
    if (!time) throw new OpenChamberControlError('time is required with once', 400);
    const schedule: TaskSchedule = { kind: 'once', date: once, time };
    if (timezone) schedule.timezone = timezone;
    return schedule;
  }
  const schedule: TaskSchedule = { kind: 'cron', cron };
  if (timezone) schedule.timezone = timezone;
  return schedule;
};

const assertWorktreeIsolation = (input: ControlInput, targetSessionId: ControlInput['targetSessionId']) => {
  for (const field of ['runInWorktree', 'cleanupWorktree'] as const) {
    if (input[field] !== undefined && !isBoolean(input[field])) {
      throw new OpenChamberControlError(`${field} must be a boolean`, 400);
    }
  }
  const { baseBranch } = input;
  if (baseBranch !== undefined && baseBranch !== null && baseBranch !== '' && !asNonEmptyString(baseBranch)) {
    throw new OpenChamberControlError('baseBranch must be a branch name, or empty to clear it', 400);
  }
  const isolationNamed = (['runInWorktree', 'baseBranch', 'cleanupWorktree'] as const).some((field) => input[field] !== undefined);
  if (isolationNamed && asNonEmptyString(targetSessionId)) {
    throw new OpenChamberControlError('runInWorktree, baseBranch and cleanupWorktree are not compatible with an existing session', 400);
  }
};

export const buildScheduledTask = (input: ControlInput) => {
  const name = asNonEmptyString(input.name);
  const prompt = asNonEmptyString(input.prompt);
  if (!name) throw new OpenChamberControlError('name is required', 400);
  if (!prompt) throw new OpenChamberControlError('prompt is required', 400);
  const targetSessionId = asNonEmptyString(input.targetSessionId);
  const model = targetSessionId && input.model === undefined ? { useDefaults: !asNonEmptyString(input.agent) } : parseModel(input.model);
  const goalTokenBudget = input.goalTokenBudget;
  if (goalTokenBudget !== undefined && input.goal !== true) {
    throw new OpenChamberControlError('goalTokenBudget requires goal', 400);
  }
  if (goalTokenBudget !== undefined && (!isSafeInteger(goalTokenBudget) || goalTokenBudget < 1000 || goalTokenBudget > 100_000_000)) {
    throw new OpenChamberControlError('goalTokenBudget must be from 1000 to 100000000', 400);
  }
  assertWorktreeIsolation(input, targetSessionId);
  const baseBranch = asNonEmptyString(input.baseBranch);
  const task: ControlTask = {
    name,
    enabled: input.disabled !== true,
    schedule: buildSchedule(input),
    execution: {
      prompt,
      ...model,
    },
  };
  if (hasText(input.agent)) task.execution.agent = input.agent.trim();
  if (hasText(input.variant)) task.execution.variant = input.variant.trim();
  if (input.goal === true) task.execution.goalEnabled = true;
  if (goalTokenBudget !== undefined) task.execution.goalTokenBudget = goalTokenBudget;
  if (input.targetSessionId !== undefined) task.targetSessionId = targetSessionId ?? input.targetSessionId;
  if (input.runInWorktree === true) task.runInWorktree = true;
  if (input.cleanupWorktree === false) task.cleanupWorktree = false;
  if (baseBranch) task.baseBranch = baseBranch;
  return task;
};

export const patchScheduledTask = (existing: ControlTask & { id: string }, input: ControlInput) => {
  if (existing.loopFile) {
    throw new OpenChamberControlError(`This task comes from ${existing.loopFile}; change that file instead`, 409);
  }
  const execution = { ...existing.execution };
  if (input.prompt !== undefined) {
    const prompt = asNonEmptyString(input.prompt);
    if (!prompt) throw new OpenChamberControlError('prompt cannot be empty', 400);
    execution.prompt = prompt;
  }
  if (input.model !== undefined) {
    Object.assign(execution, parseModel(input.model));
    delete execution.variant;
    delete execution.useDefaults;
  }
  for (const field of ['variant', 'agent'] as const) {
    if (input[field] === undefined) continue;
    const value = asNonEmptyString(input[field]);
    if (value) execution[field] = value;
    else delete execution[field];
    if (field === 'agent' && value && (input.targetSessionId || existing.targetSessionId)) delete execution.useDefaults;
  }
  if (isBoolean(input.goal)) {
    if (input.goal) execution.goalEnabled = true;
    else {
      delete execution.goalEnabled;
      delete execution.goalTokenBudget;
    }
  }
  if (input.goalTokenBudget !== undefined) {
    if (!execution.goalEnabled) throw new OpenChamberControlError('goalTokenBudget requires goal', 400);
    if (!isSafeInteger(input.goalTokenBudget) || input.goalTokenBudget < 1000 || input.goalTokenBudget > 100_000_000) {
      throw new OpenChamberControlError('goalTokenBudget must be from 1000 to 100000000', 400);
    }
    execution.goalTokenBudget = input.goalTokenBudget;
  }
  let name: string | null = existing.name;
  if (input.name !== undefined) {
    name = asNonEmptyString(input.name);
    if (!name) throw new OpenChamberControlError('name cannot be empty', 400);
  }
  const selectors = (['daily', 'weekly', 'once', 'cron'] as const).filter((key) => input[key] !== undefined);
  if (selectors.length > 1 || (selectors.length === 1 && !asNonEmptyString(input[selectors[0] ?? 'daily']))) {
    throw new OpenChamberControlError('Provide exactly one nonempty daily, weekly, once, or cron selector', 400);
  }
  const timezone = asNonEmptyString(input.timezone);
  let schedule = selectors.length === 1
    ? buildSchedule(input)
    : (timezone ? { ...existing.schedule, timezone } : existing.schedule);
  if (input.time !== undefined) {
    const time = asNonEmptyString(input.time);
    if (!time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw new OpenChamberControlError('time must be HH:mm', 400);
    }
    if (schedule.kind === 'once') {
      schedule = { ...schedule, time };
    } else if (schedule.kind === 'weekly' && schedule.times.length === 1) {
      schedule = { ...schedule, times: [time] };
    } else {
      throw new OpenChamberControlError('time requires a once or single-time weekly schedule; provide an explicit schedule to replace other schedules', 400);
    }
  }

  assertWorktreeIsolation(
    input,
    input.targetSessionId === undefined ? existing.targetSessionId : input.targetSessionId,
  );
  const patch: ControlTask = {
    id: existing.id,
    targetSessionId: input.targetSessionId === undefined ? existing.targetSessionId : input.targetSessionId,
    name,
    enabled: isBoolean(input.disabled) ? !input.disabled : existing.enabled,
    schedule,
    execution,
  };
  if (input.runInWorktree !== undefined) patch.runInWorktree = input.runInWorktree;
  if (input.cleanupWorktree !== undefined) patch.cleanupWorktree = input.cleanupWorktree;
  if (input.baseBranch !== undefined) patch.baseBranch = asNonEmptyString(input.baseBranch);
  return patch;
};
