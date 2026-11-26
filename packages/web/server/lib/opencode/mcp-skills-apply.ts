import { z } from 'zod';
import type { OpenCode } from '@opencode/client';

type OpenCodeClient = ReturnType<typeof OpenCode.make>;
type ClientFor = (directory: string | null) => OpenCodeClient;

const configEntriesSchema = z.array(z.object({
  path: z.string().optional(),
  info: z.object({ experimental: z.object({ mcp_skills: z.boolean().optional() }).optional() }).optional(),
}));

const CONFIRM_DEADLINE_MS = 5_000;
const CONFIRM_POLL_MS = 100;
const IDLE_RETRY_MS = 15_000;
const IDLE_RETRY_LIMIT = 240;

let generation = 0;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const seesFlag = async (client: OpenCodeClient, configPath: string, enabled: boolean) => {
  const deadline = Date.now() + CONFIRM_DEADLINE_MS;
  while (Date.now() < deadline) {
    const entries = configEntriesSchema.safeParse(await client.config.get());
    if (entries.success && entries.data.find((entry) => entry.path === configPath)?.info?.experimental?.mcp_skills === enabled) return true;
    await pause(CONFIRM_POLL_MS);
  }
  return false;
};

const runningSessionDirectories = async (clientFor: ClientFor) => {
  const client = clientFor(null);
  const sessions = await Promise.all(Object.keys(await client.session.active()).map((sessionID) => client.session.get({ sessionID })));
  return new Set(sessions.map((session) => session.location.directory));
};

const hasLiveWork = async (client: OpenCodeClient, directory: string, running: ReadonlySet<string>) => {
  if (running.has(directory)) return true;
  const [permissions, forms, terminals] = await Promise.all([client.permission.request.list(), client.form.list(), client.pty.list()]);
  return permissions.data.length > 0 || forms.data.length > 0 || terminals.data.length > 0;
};

const rebuildWhenIdle = async (clientFor: ClientFor, directory: string, configPath: string, enabled: boolean, ownGeneration: number, attempt: number): Promise<void> => {
  if (ownGeneration !== generation || attempt > IDLE_RETRY_LIMIT) return;
  const client = clientFor(directory);
  const ready = await seesFlag(client, configPath, enabled) && !await hasLiveWork(client, directory, await runningSessionDirectories(clientFor));
  if (ready && ownGeneration === generation) {
    await client.debug.location.evict({ location: { directory } });
    return;
  }
  setTimeout(() => {
    void rebuildWhenIdle(clientFor, directory, configPath, enabled, ownGeneration, attempt + 1).catch(() => undefined);
  }, IDLE_RETRY_MS).unref?.();
};

export const applyMcpSkillsFlag = async (clientFor: ClientFor, configPath: string, enabled: boolean) => {
  const ownGeneration = ++generation;
  const locations = await clientFor(null).debug.location.list();
  await Promise.all(locations.map(({ directory }) => rebuildWhenIdle(clientFor, directory, configPath, enabled, ownGeneration, 0)));
};
