import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isPrimitiveString, isRecord } from '../shared/guards.js';
import { projectConfigFileStemOf } from '../projects/project-id.js';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { readBotsConfig } from './config.js';

const projectId = z.string().regex(/^[A-Za-z0-9._:-]+$/).refine((id) => id !== '.' && id !== '..');
const object = z.record(z.string(), z.unknown());
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const schedule = z.object({
  kind: z.enum(['daily', 'weekly', 'cron', 'once']),
  time: time.optional(), times: z.array(time).min(1).optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  cron: z.string().min(1).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timezone: z.string().min(1).optional(),
}).passthrough().refine((value) => value.kind === 'cron' ? Boolean(value.cron)
  : value.kind === 'once' ? Boolean(value.date && value.time)
    : Boolean((value.time || value.times) && (value.kind !== 'weekly' || value.weekdays)), 'Invalid bot schedule');
const botTask = z.object({
  id: z.string().min(1), botId: z.string().regex(/^[A-Za-z0-9_-]+$/), botManaged: z.literal(true).optional(),
  name: z.string().min(1), enabled: z.boolean(), schedule,
  execution: object, state: object.optional(),
}).passthrough().refine((task) => !task.loopFile && !task.suggestedScan && !task.targetSessionId, 'Conflicting bot task owner');
const isBotScheduledRow = (row) => Boolean(row?.botId || row?.botManaged);

/** Validation preserves the raw document, including fields a newer writer owns. */
export function validateOwnerBotsProject(raw) {
  if (!isRecord(raw) || raw.version !== 1
    || raw.scheduledTasks !== undefined && !Array.isArray(raw.scheduledTasks)) throw new Error('Invalid owner Bots project config');
  const config = readBotsConfig(raw.bots);
  if (!config.ok) throw new Error(`Invalid bots config: ${config.error}`);
  const ids = new Set();
  for (const row of raw.scheduledTasks ?? []) {
    if (!row || !isPrimitiveString(row.id) || !row.id || ids.has(row.id)) throw new Error('Invalid or duplicate scheduled task identity');
    ids.add(row.id);
    if (isBotScheduledRow(row)) botTask.parse(row);
  }
  return raw;
}

/** Owner-local storage only. No checkout path is decoded or project config runtime constructed. */
export function createOwnerBotConfig({ projectsDirPath, resolveProject = null, fsImpl = fs, now = Date.now }) {
  const filePathFor = (id) => path.join(projectsDirPath, `${projectConfigFileStemOf(projectId.parse(id))}.json`);
  const locked = async (id, work) => {
    projectId.parse(id);
    if (resolveProject && (await resolveProject(id))?.id !== id) throw new Error('Unknown owner Bots project');
    return withSourceControlFileLock(`${filePathFor(id)}.lock`, work, { fsImpl, waitMs: 10_000 });
  };
  const read = async (id) => {
    try {
      await fsImpl.lstat(`${filePathFor(id)}.bots-migration-blocked`);
      throw new Error('Bots migration is blocked for this project');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { return validateOwnerBotsProject(JSON.parse(await fsImpl.readFile(filePathFor(id), 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, scheduledTasks: [] }; throw error; }
  };
  const write = async (id, value) => {
    validateOwnerBotsProject(value);
    const file = filePathFor(id);
    const temporary = `${file}.tmp-${randomUUID()}`;
    try {
      await fsImpl.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await fsImpl.rename(temporary, file);
    } finally { await fsImpl.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  };
  const rows = (value) => (value.scheduledTasks ?? []).filter(isBotScheduledRow);
  const updateScheduledTaskStateIf = (id, taskId, predicate, patch) => locked(id, async () => {
    const current = await read(id);
    const task = rows(current).find((row) => row.id === taskId);
    if (!task || !predicate(structuredClone(task))) return { task: task ?? null, tasks: rows(current), updated: false };
    const next = { ...task, state: { ...task.state, ...patch, updatedAt: now() } };
    await write(id, { ...current, scheduledTasks: current.scheduledTasks.map((row) => row.id === taskId ? next : row) });
    return { task: next, tasks: rows(current).map((row) => row.id === taskId ? next : row), updated: true };
  });
  return {
    filePathFor,
    readBotsSection: (id) => locked(id, async () => (await read(id)).bots),
    updateBotsSection: (id, change) => locked(id, async () => {
      const current = await read(id);
      const bots = await change(structuredClone(current.bots));
      await write(id, { ...current, bots });
      return bots;
    }),
    listScheduledTasks: (id) => locked(id, async () => rows(await read(id))),
    upsertScheduledTask: (id, input) => locked(id, async () => {
      botTask.parse(input);
      const current = await read(id);
      const existing = current.scheduledTasks?.find((row) => row.id === input.id);
      if (existing && (!isBotScheduledRow(existing) || existing.botId !== input.botId)) throw new Error('Scheduled task belongs to another owner');
      const task = { ...existing, ...input, botManaged: true, state: existing?.state ?? input.state ?? {},
        createdAt: existing?.createdAt ?? input.createdAt ?? now(), updatedAt: now() };
      const tasks = existing ? current.scheduledTasks.map((row) => row.id === task.id ? task : row) : [...current.scheduledTasks ?? [], task];
      await write(id, { ...current, scheduledTasks: tasks });
      return { task, tasks: rows({ scheduledTasks: tasks }), created: !existing };
    }),
    deleteScheduledTask: (id, taskId) => locked(id, async () => {
      const current = await read(id);
      const existing = current.scheduledTasks?.find((row) => row.id === taskId);
      if (existing && !isBotScheduledRow(existing)) throw new Error('Scheduled task belongs to another owner');
      const tasks = (current.scheduledTasks ?? []).filter((row) => row.id !== taskId);
      if (existing) await write(id, { ...current, scheduledTasks: tasks });
      return { deleted: Boolean(existing), tasks: rows({ scheduledTasks: tasks }) };
    }),
    updateScheduledTaskStateIf,
    updateScheduledTaskState: (id, taskId, patch) => updateScheduledTaskStateIf(id, taskId, () => true, patch),
  };
}
