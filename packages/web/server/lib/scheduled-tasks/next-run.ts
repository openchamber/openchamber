import type { ScheduledTask } from '../projects/contracts.js';
import { DateTime } from 'luxon';
import { CronExpressionParser } from 'cron-parser';

import { isString } from '../shared/object-guards.js';

export const TASK_DUE_SLACK_MS = 5_000;

export type ScheduleInput = { timezone?: string } & (
  | { kind: 'daily'; times?: string[]; time?: string }
  | { kind: 'weekly'; times?: string[]; time?: string; weekdays?: number[] }
  | { kind: 'once'; date: string; time: string }
  | { kind: 'cron'; cron: string }
);

const isScheduleObject = (value: unknown): value is object => value !== null && typeof value === 'object';

const parseTimeParts = (time: string | undefined) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time ?? '');
  if (!match) {
    return null;
  }
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
};

const applyTimeToDate = (baseDateTime: DateTime, time: string | undefined) => {
  const parsed = parseTimeParts(time);
  if (!parsed) {
    return null;
  }
  return baseDateTime.set({
    hour: parsed.hour,
    minute: parsed.minute,
    second: 0,
    millisecond: 0,
  });
};

const resolveScheduleTimes = (schedule: { times?: string[]; time?: string }) => {
  const times: string[] = [];
  if (Array.isArray(schedule?.times)) {
    for (const candidate of schedule.times) {
      if (isString(candidate) && /^([01]\d|2[0-3]):([0-5]\d)$/.test(candidate)) {
        times.push(candidate);
      }
    }
  }
  if (times.length === 0 && isString(schedule?.time) && /^([01]\d|2[0-3]):([0-5]\d)$/.test(schedule.time)) {
    times.push(schedule.time);
  }
  return Array.from(new Set(times)).sort((a, b) => a.localeCompare(b));
};

const weekdayAsZeroBased = (dateTime: DateTime | null) => {
  if (!dateTime) {
    return null;
  }
  return dateTime.weekday % 7;
};

export const computeNextRunAt = (task: { enabled: boolean; schedule?: ScheduleInput } | null | undefined, nowMs = Date.now()) => {
  if (!task?.enabled) {
    return null;
  }

  const schedule = task.schedule;
  if (!schedule || !isScheduleObject(schedule)) {
    return null;
  }

  const zone = isString(schedule.timezone) && schedule.timezone.trim().length > 0
    ? schedule.timezone.trim()
    : DateTime.local().zoneName;

  const now = DateTime.fromMillis(nowMs, { zone });
  if (!now.isValid) {
    return null;
  }

  if (schedule.kind === 'daily') {
    const times = resolveScheduleTimes(schedule);
    if (times.length === 0) {
      return null;
    }
    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });

    for (const time of times) {
      const candidateToday = applyTimeToDate(now, time);
      if (!candidateToday || !candidateToday.isValid) {
        continue;
      }
      if (candidateToday > minAllowed) {
        return candidateToday.toMillis();
      }
    }

    const tomorrow = now.plus({ days: 1 });
    const firstTomorrow = applyTimeToDate(tomorrow, times[0]);
    return firstTomorrow?.isValid ? firstTomorrow.toMillis() : null;
  }

  if (schedule.kind === 'weekly') {
    if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) {
      return null;
    }
    const times = resolveScheduleTimes(schedule);
    if (times.length === 0) {
      return null;
    }
    const weekdaysSet = new Set(schedule.weekdays);
    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });

    for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
      const dayCandidate = now.plus({ days: dayOffset });
      const zeroBasedWeekday = weekdayAsZeroBased(dayCandidate);
      if (zeroBasedWeekday === null || !weekdaysSet.has(zeroBasedWeekday)) {
        continue;
      }
      for (const time of times) {
        const withTime = applyTimeToDate(dayCandidate, time);
        if (!withTime || !withTime.isValid) {
          continue;
        }
        if (withTime > minAllowed) {
          return withTime.toMillis();
        }
      }
    }
    return null;
  }

  if (schedule.kind === 'once') {
    if (!isString(schedule.date) || !isString(schedule.time)) {
      return null;
    }

    const parsed = DateTime.fromFormat(
      `${schedule.date} ${schedule.time}`,
      'yyyy-LL-dd HH:mm',
      { zone },
    );
    if (!parsed.isValid) {
      return null;
    }

    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });
    if (parsed <= minAllowed) {
      return null;
    }

    return parsed.toMillis();
  }

  if (schedule.kind === 'cron') {
    try {
      const iterator = CronExpressionParser.parse(schedule.cron, {
        tz: zone,
        currentDate: new Date(nowMs),
      });
      return iterator.next().getTime();
    } catch {
      return null;
    }
  }

  return null;
};

export const sameSchedule = (a: ScheduledTask, b: ScheduledTask) => JSON.stringify(a.schedule) === JSON.stringify(b.schedule);

export const unstartedRunAt = (task: ScheduledTask, nowMs = Date.now()) => {
  const due = computeNextRunAt(task, nowMs - 2 * TASK_DUE_SLACK_MS);
  return due !== null && due > nowMs - TASK_DUE_SLACK_MS && due === task.state.nextRunAt && due !== task.state.lastScheduledFor ? due : null;
};
