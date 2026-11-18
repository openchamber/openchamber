import { z } from 'zod';

const botIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const managedRowsSchema = z.array(z.object({
  id: z.string(),
  botId: botIdSchema,
  botManaged: z.literal(true),
  name: z.string().trim().min(1),
  enabled: z.boolean(),
  schedule: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('daily'), times: z.array(z.string()).min(1), timezone: z.string().optional() }),
    z.object({ kind: z.literal('weekly'), times: z.array(z.string()).min(1), weekdays: z.array(z.number().int().min(0).max(6)).min(1), timezone: z.string().optional() }),
    z.object({ kind: z.literal('cron'), cron: z.string().min(1), timezone: z.string().optional() }),
  ]),
  execution: z.object({ prompt: z.string().min(1), useDefaults: z.literal(true), notify: z.enum(['finish', 'attention']) }),
}).refine((row) => row.id === `bot-${row.botId}`, 'bot task id must match its owner'))
  .refine((rows) => new Set(rows.map((row) => row.botId)).size === rows.length, 'bot task owners must be unique');

/** Internal config projection. Public task mutations go through the scheduled-task service. */
export const createBotScheduler = ({ projectConfigRuntime, scheduledTasksRuntime }) => {
  const sync = async (projectId, managedRows) => {
    const rows = managedRowsSchema.parse(managedRows);
    const current = await projectConfigRuntime.listScheduledTasks(projectId);
    for (const row of rows) {
      const existing = current.find((task) => task.id === row.id);
      if (existing && existing.botId !== row.botId) throw new Error(`Task ${row.id} belongs to another owner`);
    }
    // Upsert preserves the latest runtime state under the project config lock.
    // Remove obsolete owners only after every replacement persisted successfully.
    for (const row of rows) await projectConfigRuntime.upsertScheduledTask(projectId, row);
    const owners = new Set(rows.map((row) => row.botId));
    for (const task of current) {
      if (task.botId && !owners.has(task.botId)) await projectConfigRuntime.deleteScheduledTask(projectId, task.id);
    }
    return scheduledTasksRuntime.syncProject(projectId);
  };

  const remove = async (projectId, botId) => {
    botIdSchema.parse(botId);
    const tasks = await projectConfigRuntime.listScheduledTasks(projectId);
    for (const task of tasks) {
      if (task.botId === botId) await projectConfigRuntime.deleteScheduledTask(projectId, task.id);
    }
    return scheduledTasksRuntime.syncProject(projectId);
  };

  return { sync, remove };
};
