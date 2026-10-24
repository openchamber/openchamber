import React from 'react';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const ENDPOINT = '/api/openchamber/maintenance/database';
const POLL_INTERVAL_MS = 1500;

const COMPACTION_PHASES = [
  'stopping',
  'checkpoint',
  'vacuum',
  'integrity',
  'restarting',
  'done',
  'failed',
] as const;

const lastCompactionSchema = z.object({
  at: z.string(),
  trigger: z.enum(['manual', 'next-restart']),
  beforeBytes: z.number(),
  afterBytes: z.number(),
  freedBytes: z.number(),
});

const compactionSchema = z.object({
  id: z.string(),
  phase: z.enum(COMPACTION_PHASES),
  trigger: z.enum(['manual', 'next-restart']),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  error: z.string().nullable(),
  beforeBytes: z.number().nullable(),
});

const overviewSchema = z.object({
  path: z.string().nullable(),
  inMemory: z.boolean(),
  exists: z.boolean(),
  bytes: z.number(),
  walBytes: z.number(),
  pageSize: z.number(),
  pageCount: z.number(),
  freelistCount: z.number(),
  reclaimableBytes: z.number(),
  liveBytes: z.number(),
  openCodeRunning: z.boolean(),
  externalOpenCode: z.boolean(),
  activeTurns: z.number(),
  pendingOnNextRestart: z.boolean(),
  blockedReason: z.string().nullable(),
  compaction: compactionSchema.nullable(),
  lastCompaction: lastCompactionSchema.nullable(),
});

type DatabaseMaintenanceOverview = z.infer<typeof overviewSchema>;
export type DatabaseCompactionPhase = (typeof COMPACTION_PHASES)[number];

const errorBodySchema = z.object({ error: z.string() });

const RUNNING_PHASES = new Set<DatabaseCompactionPhase>(['stopping', 'checkpoint', 'vacuum', 'integrity', 'restarting']);

const readOverview = async (signal?: AbortSignal): Promise<DatabaseMaintenanceOverview> => {
  const response = await runtimeFetch(ENDPOINT, { signal });
  if (!response.ok) throw new Error(`The database overview answered ${response.status}`);
  const parsed = overviewSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('The database overview has an unexpected shape');
  return parsed.data;
};

const postAction = async (suffix: string) => {
  const response = await runtimeFetch(`${ENDPOINT}${suffix}`, { method: 'POST' });
  if (!response.ok) {
    const parsedBody = errorBodySchema.safeParse(await response.json().catch(() => null));
    throw new Error(parsedBody.success ? parsedBody.data.error : `The request answered ${response.status}`);
  }
};

interface UseDatabaseMaintenanceResult {
  overview: DatabaseMaintenanceOverview | null;
  /** Why the overview could not be read; null while it is loading or readable. */
  error: string | null;
  isLoading: boolean;
  /** A rewrite is stopping, rewriting or restarting OpenCode right now. */
  isRunning: boolean;
  refresh: () => Promise<void>;
  compactDatabase: () => Promise<void>;
  scheduleCompaction: () => Promise<void>;
}

/**
 * Database storage for the Sessions settings page. The rewrite outlives the
 * POST that starts it, so the overview is polled while a phase is running.
 */
export const useDatabaseMaintenance = (): UseDatabaseMaintenanceResult => {
  const [overview, setOverview] = React.useState<DatabaseMaintenanceOverview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = React.useCallback(async () => {
    try {
      const next = await readOverview();
      if (!mounted.current) return;
      setOverview(next);
      setError(null);
    } catch (loadError) {
      if (!mounted.current) return;
      setError(loadError instanceof Error ? loadError.message : 'The database overview failed');
    } finally {
      if (mounted.current) setIsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const isRunning = overview?.compaction ? RUNNING_PHASES.has(overview.compaction.phase) : false;

  React.useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isRunning, refresh]);

  const compactDatabase = React.useCallback(async () => {
    await postAction('/compact');
    await refresh();
  }, [refresh]);

  const scheduleCompaction = React.useCallback(async () => {
    await postAction('/compact-on-next-restart');
    await refresh();
  }, [refresh]);

  return { overview, error, isLoading, isRunning, refresh, compactDatabase, scheduleCompaction };
};
