import { z } from 'zod';

import { isString } from '../shared/guards.js';

const DIRECTORY_NAME = 'workflow-runs';
const FILE_VERSION = 1;
// Finished runs beyond this many are removed, oldest first; a run that has
// not finished is never removed.
const MAX_RUNS = 100;

const RUN_ID_PATTERN = /^wf_[A-Za-z0-9]{8,40}$/;

const agentSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  phase: z.string().nullable(),
  prompt: z.string(),
  agent: z.string().optional(),
  model: z.string().optional(),
  schema: z.unknown().optional(),
  sessionId: z.string().optional(),
  // Read from the agent's session once its call settles.
  modelUsed: z.string().optional(),
  usage: z.object({
    cost: z.number(),
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }).optional(),
  state: z.enum(['queued', 'running', 'completed', 'failed', 'stopped']),
  replayed: z.boolean().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

const RUN_STATES = ['awaiting-approval', 'running', 'completed', 'failed', 'stopped', 'declined'];

const runSchema = z.object({
  version: z.literal(FILE_VERSION),
  id: z.string().regex(RUN_ID_PATTERN),
  parentSessionId: z.string().min(1),
  directory: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  phases: z.array(z.string()),
  script: z.string(),
  args: z.unknown().optional(),
  state: z.enum(RUN_STATES),
  attempt: z.number().int().nonnegative(),
  // Absent in runs saved before the limit counted across attempts.
  agentsStarted: z.number().int().nonnegative().optional(),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  // The server process running it; absent in runs saved before it was recorded.
  ownerPid: z.number().int().positive().optional(),
  currentPhase: z.string().nullable(),
  agents: z.array(agentSchema),
  logs: z.array(z.object({ at: z.number(), message: z.string() })),
  result: z.unknown().optional(),
  error: z.string().optional(),
  report: z.object({ messageId: z.string(), delivered: z.boolean(), resume: z.boolean() }).optional(),
});

export const isWorkflowRunId = (value) => isString(value) && RUN_ID_PATTERN.test(value);

const isFinished = (run) => run.state !== 'running' && run.state !== 'awaiting-approval';

/**
 * Workflow runs on disk, one owner-readable JSON file each under
 * `<dataDir>/workflow-runs/`, written atomically through one write chain.
 * A file that does not parse is moved aside and the rest load; a failed
 * directory read keeps writes off until a load succeeds, so it can never pass
 * for "no runs" and be overwritten.
 */
export const createWorkflowRunStore = ({ fsPromises, path, dataDir, now = Date.now }) => {
  const directory = path.join(dataDir, DIRECTORY_NAME);
  const runs = new Map();
  let loadPromise = null;
  let writeChain = Promise.resolve();

  const fileFor = (id) => path.join(directory, `${id}.json`);

  const readAll = async () => {
    let names;
    try {
      names = await fsPromises.readdir(directory);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(directory, name);
      const parsed = runSchema.safeParse(await fsPromises.readFile(filePath, 'utf8').then(JSON.parse).catch(() => null));
      if (parsed.success) {
        runs.set(parsed.data.id, parsed.data);
      } else {
        const aside = `${filePath}.corrupt-${now()}`;
        await fsPromises.rename(filePath, aside).catch(() => undefined);
        console.warn(`[workflows] run file ${name} was unreadable and moved to ${aside}`);
      }
    }
  };

  const load = () => {
    loadPromise ??= readAll().catch((error) => {
      loadPromise = null;
      throw error;
    });
    return loadPromise;
  };

  const writeRun = async (run) => {
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    const target = fileFor(run.id);
    const temporary = `${target}.${process.pid}.tmp`;
    await fsPromises.writeFile(temporary, JSON.stringify(run), { encoding: 'utf8', mode: 0o600 });
    await fsPromises.rename(temporary, target);
  };

  // Oldest end first; a run whose report has not gone out is kept, and so is
  // the one just saved, so a resumed old run is not dropped as it finishes.
  const prune = async (savedId) => {
    const finished = [...runs.values()]
      .filter((run) => isFinished(run) && run.id !== savedId && (!run.report || run.report.delivered))
      .sort((left, right) => (left.endedAt ?? left.createdAt) - (right.endedAt ?? right.createdAt));
    for (const run of finished.slice(0, Math.max(0, runs.size - MAX_RUNS))) {
      runs.delete(run.id);
      await fsPromises.rm(fileFor(run.id), { force: true }).catch(() => undefined);
    }
  };

  /** Saves the run as it is now; resolves once it is on disk. */
  const save = async (run) => {
    await load();
    runs.set(run.id, run);
    const snapshot = structuredClone(run);
    writeChain = writeChain
      .then(() => writeRun(snapshot))
      .then(() => prune(snapshot.id))
      .catch((error) => {
        console.warn(`[workflows] failed to save run ${snapshot.id}:`, error?.message ?? error);
      });
    return writeChain;
  };

  const get = async (id) => {
    await load();
    return runs.get(id) ?? null;
  };

  const list = async () => {
    await load();
    return [...runs.values()].sort((left, right) => left.createdAt - right.createdAt);
  };

  /**
   * Deletes a run's file. Resolves once it is gone; a failed removal rejects
   * and puts the run back, so it never vanishes from the list only to come
   * back after a restart.
   */
  const remove = async (id) => {
    await load();
    const run = runs.get(id);
    if (!run) return false;
    runs.delete(id);
    const removal = writeChain.then(() => fsPromises.rm(fileFor(id), { force: true }));
    writeChain = removal.catch((error) => {
      console.warn(`[workflows] failed to delete run ${id}:`, error?.message ?? error);
    });
    try {
      await removal;
    } catch (error) {
      runs.set(id, run);
      throw error;
    }
    return true;
  };

  return { version: FILE_VERSION, load, save, get, list, remove, flush: () => writeChain };
};
