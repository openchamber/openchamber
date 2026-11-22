/**
 * Schedule shapes. The wire carries a schedule list exactly as the config file
 * holds it (`storedSchedulesSchema`); the editor reads it entry by entry with
 * `globalScheduleSchema`.
 */
import { z } from 'zod';

const scheduleWindowSchema = z
  .object({
    daysOfWeek: z.array(z.union([z.string(), z.number()])).optional(),
    daysOfMonth: z.array(z.number()).optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    timezone: z.string().optional(),
    from: z.number().optional(),
    until: z.number().optional(),
  })
  .passthrough();

/**
 * One schedule as far as the editor can read it: OpenCode's `Schedule` inside
 * a pool, plus the `GlobalSchedule` match lists across pools. Schedules arrive
 * as stored (`storedSchedulesSchema`) and are read entry by entry with this, so
 * a hand-written entry it cannot read still loads, shows read-only, and the
 * server names the problem on save.
 */
export const globalScheduleSchema = z
  .object({
    id: z.string().optional(),
    providers: z.array(z.string()).optional(),
    models: z.array(z.string()).optional(),
    targets: z.array(z.string()).optional(),
    routes: z.array(z.string()).optional(),
    when: scheduleWindowSchema.optional(),
    factor: z.number().optional(),
    weight: z.number().optional(),
    note: z.string().optional(),
  })
  .passthrough();

/** A schedule list exactly as the config file holds it. */
export const storedSchedulesSchema = z.json();

export type ScheduleWindow = z.infer<typeof scheduleWindowSchema>;
export type GlobalSchedule = z.infer<typeof globalScheduleSchema>;
export type StoredSchedules = z.infer<typeof storedSchedulesSchema>;
/** What a save sends: entries the editor read, and the ones it kept as stored. */
export type ScheduleListValue = ReadonlyArray<GlobalSchedule | StoredSchedules>;
/** A schedule list as loaded, or as edited and not yet confirmed by the server. */
export type ScheduleList = StoredSchedules | ScheduleListValue;
