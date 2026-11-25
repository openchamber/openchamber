import { opencodeClient } from '@/lib/opencode/client';
import { delay } from '@/lib/timing/delay';
import { createSessionLineage } from '@/stores/sessionLineage';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import type { ChildStoreManager } from '@/sync/child-store';
import { moveSessionToDirectory } from '@/sync/session-actions';
import { waitUntilSessionsMoved } from './sessionWorktreeMove';
import { readSessionsInWorktree } from './worktreeUse';

const STOP_TIMEOUT_MS = 10_000;
const STOP_POLL_MS = 200;

const stopSession = async (sessionId: string, directory: string, isCurrent: () => boolean): Promise<void> => {
  await opencodeClient.abortSession(sessionId, directory).catch(() => false);
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isCurrent() && Date.now() < deadline) {
    const statuses = await opencodeClient.getActiveSessionStatuses(directory);
    if (statuses && !statuses[sessionId]) return;
    await delay(STOP_POLL_MS);
  }
  if (isCurrent()) throw new Error('The session did not stop');
};

export const moveSessionsOutOfIntegrateCheckout = async (
  childStores: ChildStoreManager,
  checkout: string,
  projectDirectory: string,
  isCurrent: () => boolean,
): Promise<{ moved: number; failed: number }> => {
  const sessions = readSessionsInWorktree(childStores, checkout);
  const lineage = createSessionLineage(sessions);
  const deepestFirst = [...sessions].sort((left, right) => (
    lineage.descendantsOf(left.id, 'active').length - lineage.descendantsOf(right.id, 'active').length
  ));
  let moved = 0;
  for (const session of deepestFirst) {
    if (!isCurrent()) break;
    const source = resolveGlobalSessionDirectory(session) ?? checkout;
    try {
      await stopSession(session.id, source, isCurrent);
      if (!isCurrent()) break;
      await moveSessionToDirectory(session, source, projectDirectory, isCurrent);
      if (await waitUntilSessionsMoved([{ sessionId: session.id, directory: projectDirectory }], isCurrent)) moved += 1;
    } catch (error) {
      console.warn('[integrate] Failed to move a session out of the temporary checkout', error);
    }
  }
  return { moved, failed: isCurrent() ? sessions.length - moved : 0 };
};
