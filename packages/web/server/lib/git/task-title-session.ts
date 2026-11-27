import { z } from 'zod';
import { directoryExists } from './reachable-disk.js';
import { readGitConfigValue, runGitCommand, setWorktreeTaskTitle, toTaskTitle, writeGitConfigValue } from './service.js';
import type { SessionInfo } from '@opencode/client';
import type { TranslatedEvent } from '../event-stream/translate-v2.js';

interface TaskTitleInput {
  title: string;
  by: 'user' | 'agent';
  session?: string | undefined;
}

const sessionKey = (branch: string) => `branch.${branch}.openchamberTitleSession`;

const readLinkedBranch = async (directory: string) => {
  const result = await runGitCommand(directory, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--abbrev-ref', 'HEAD']);
  if (!result.success) return null;
  const [gitDir, commonDir, branch] = String(result.stdout || '').split(/\r?\n/);
  return gitDir && commonDir && gitDir !== commonDir && branch && branch !== 'HEAD' ? branch : null;
};

export const setLinkedTaskTitle = async (directory: string, { title, by, session }: TaskTitleInput) => {
  const result = await setWorktreeTaskTitle(directory, { title, by });
  if (by === 'agent' && session && result.applied) {
    await writeGitConfigValue(directory, sessionKey(result.branch), `${session} ${result.title}`);
  }
  return result;
};

export const followSessionTaskTitle = async (directory: string, session: string, title: string) => {
  if (!session || !toTaskTitle(title) || !await directoryExists(directory)) return null;
  const branch = await readLinkedBranch(directory);
  if (!branch) return null;
  const [linked, ...copied] = (await readGitConfigValue(directory, sessionKey(branch))).split(' ');
  const current = toTaskTitle(await readGitConfigValue(directory, `branch.${branch}.description`));
  if (linked !== session || !current || current !== copied.join(' ')) return null;
  return setLinkedTaskTitle(directory, { title, by: 'agent', session });
};

const renamedSessionSchema = z.object({
  type: z.literal('session.updated'),
  properties: z.object({ info: z.object({ id: z.string().min(1), title: z.string() }) }),
});

type ReadSession = (sessionID: string) => Promise<Pick<SessionInfo, 'title' | 'location'>>;

let pendingRenames = Promise.resolve();

export const followRenamedSession = (payload: TranslatedEvent, readSession: ReadSession) => {
  const renamed = renamedSessionSchema.safeParse(payload).data?.properties.info;
  if (!renamed) return;
  pendingRenames = pendingRenames.then(async () => {
    const { title, location } = await readSession(renamed.id);
    if (location.directory && title) await followSessionTaskTitle(location.directory, renamed.id, title);
  }).catch((error) => {
    console.warn('Failed to carry a session rename into its worktree task:', error instanceof Error ? error.message : String(error));
  });
};
