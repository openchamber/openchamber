import { useCallback } from 'react';
import { create } from 'zustand';
import type { ShellToStop } from '@/lib/opencode/background-shell';
import { opencodeClient } from '@/lib/opencode/client';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { useBackgroundShellsStore, waitForShellSettle } from '@/sync/background-shells';

// OpenCode cannot cancel a shell call the turn waits for, so Stop on such a
// call moves the session's blocking work to the background and then stops the
// command there, the way a background row does. The call turns into a
// background row on the way, which unmounts the row that started the stop, so
// the stop runs outside React and its state lives here.

const SETTLE_TIMEOUT_MS = 10_000;
// A stopped command keeps its entry so the background row it turns into
// offers no second Stop. Ids are unique per command; this only bounds memory.
const MAX_STOPPING = 200;

const useStoppingShells = create<{ ids: ReadonlySet<string> }>(() => ({ ids: new Set() }));

const markStopping = (shellID: string): void => {
  const ids = new Set(useStoppingShells.getState().ids);
  ids.delete(shellID);
  ids.add(shellID);
  for (const id of ids) {
    if (ids.size <= MAX_STOPPING) break;
    ids.delete(id);
  }
  useStoppingShells.setState({ ids });
};

const unmarkStopping = (shellID: string): void => {
  const current = useStoppingShells.getState().ids;
  if (!current.has(shellID)) return;
  const ids = new Set(current);
  ids.delete(shellID);
  useStoppingShells.setState({ ids });
};

/** Whether a Stop of this command, started while the turn waited for it, is on its way or done. */
export const useForegroundShellStopping = (shellID: string | undefined): boolean => (
  useStoppingShells(useCallback((state) => (shellID ? state.ids.has(shellID) : false), [shellID]))
);

/**
 * Stops a command the turn waits for: moves the session's blocking work to
 * the background (every shell or subagent it waits for, as OpenCode does it),
 * waits for this command's call to settle there, then stops the command with
 * the note a background stop posts. Resolves without stopping anything when
 * the command ended on its own first. Rejects when backgrounding fails, the
 * call does not settle within `settleTimeoutMs` (OpenCode found nothing
 * blocking, or the event fell into a stream gap), the runtime changes, or
 * the stop fails; the command may then run on in the background, where its
 * row offers the ordinary Stop.
 */
export const stopForegroundShell = async (
  params: { sessionID: string; sessionDirectory?: string | null; shell: ShellToStop },
  settleTimeoutMs = SETTLE_TIMEOUT_MS,
): Promise<void> => {
  const { shellID } = params.shell;
  const ownsRuntime = captureRuntimeInstance();
  markStopping(shellID);
  try {
    // Registered first: the settle event can arrive before the route answers.
    const wait = waitForShellSettle(shellID, settleTimeoutMs);
    const [, outcome] = await Promise.all([
      opencodeClient.backgroundSessionWork(params.sessionID, params.sessionDirectory),
      wait.settled,
    ]).finally(wait.cancel);
    if (!ownsRuntime()) throw new Error('The runtime changed before the command was stopped.');
    // A command that exited right after it settled is finished, not stopped.
    if (outcome === 'ended' || !useBackgroundShellsStore.getState().byId.has(shellID)) {
      unmarkStopping(shellID);
      return;
    }
    await opencodeClient.stopBackgroundShells({
      sessionID: params.sessionID,
      sessionDirectory: params.sessionDirectory,
      shells: [params.shell],
    });
  } catch (error) {
    unmarkStopping(shellID);
    throw error;
  }
};
