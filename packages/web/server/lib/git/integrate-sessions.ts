import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { SessionClient } from '../openchamber-sessions/opencode-client-contract.js';

interface IntegrateSessionsDependencies {
  client(): SessionClient;
  listProjects(): Promise<readonly string[]>;
}

export interface IntegrateSessionsMove {
  moved: number;
  remaining: number;
  destination: string | null;
}

const MOVE_DEADLINE_MS = 20_000;
const MOVE_SETTLE_MS = 4_000;
const POLL_MS = 250;
const PAGE_SIZE = 200;
const REQUEST_TIMEOUT_MS = 10_000;

const bounded = () => ({ signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

let dependencies: IntegrateSessionsDependencies | null = null;
let resumeProject: ((directory: string) => void) | null = null;

export const onIntegrateSessionsReady = (resume: (directory: string) => void) => {
  resumeProject = resume;
};

export const configureIntegrateSessions = (next: IntegrateSessionsDependencies | null) => {
  dependencies = next;
  void next?.listProjects().then((projects) => projects.forEach((project) => resumeProject?.(project)), () => undefined);
};

export const listIntegrateProjects = async () => (dependencies ? dependencies.listProjects() : []);

export const isInside = (root: string, directory: string) => {
  const relative = path.relative(root, directory);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const listSessionsIn = async (client: SessionClient, roots: readonly string[]) => {
  const found: Array<{ id: string; directory: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await client.session.list(cursor ? { cursor } : { limit: PAGE_SIZE }, bounded());
    for (const session of page.data) {
      const { directory } = session.location;
      if (roots.some((root) => isInside(root, directory))) found.push({ id: session.id, directory });
    }
    cursor = page.cursor.next ?? undefined;
  } while (cursor);
  return found;
};

export const moveSessionsOut = async (
  roots: readonly string[],
  resolveDestination: (relativeDirectory: string) => Promise<string>,
  assertReachable: () => Promise<void>,
): Promise<IntegrateSessionsMove> => {
  if (!dependencies) return { moved: 0, remaining: 0, destination: null };
  const client = dependencies.client();
  const deadline = Date.now() + MOVE_DEADLINE_MS;
  const handled = new Set<string>();
  const requestedAt = new Map<string, number>();
  let destination: string | null = null;
  for (;;) {
    const sessions = await listSessionsIn(client, roots);
    const remaining = new Set(sessions.map((session) => session.id));
    const moved = [...handled].filter((id) => !remaining.has(id)).length;
    if (sessions.length === 0 || Date.now() >= deadline) return { moved, remaining: sessions.length, destination };

    const active = await client.session.active(bounded());
    for (const { id, directory } of sessions) {
      handled.add(id);
      if (Date.now() - (requestedAt.get(id) ?? 0) < MOVE_SETTLE_MS) continue;
      const root = roots.find((candidate) => isInside(candidate, directory)) ?? directory;
      destination = await resolveDestination(path.relative(root, directory));
      await assertReachable();
      if (Object.hasOwn(active, id)) {
        await client.session.interrupt({ sessionID: id }, bounded()).catch(() => undefined);
        continue;
      }
      requestedAt.set(id, Date.now());
      await client.session.move({ sessionID: id, directory: destination }, bounded()).catch((error) => {
        console.warn(`Failed to move session ${id} out of the temporary checkout:`, error instanceof Error ? error.message : error);
      });
    }
    await delay(POLL_MS);
  }
};

const projectsSchema = z.object({ projects: z.array(z.object({ path: z.string().min(1) })).catch([]) }).catch({ projects: [] });

export const readProjectPaths = <Settings>(readSettings: () => Promise<Settings>) => async () =>
  projectsSchema.parse(await readSettings()).projects.map((project) => project.path);
