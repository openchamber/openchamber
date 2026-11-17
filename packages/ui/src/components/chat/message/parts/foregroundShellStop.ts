import { useCallback } from 'react';
import { create } from 'zustand';
import type { ShellToStop } from '@/lib/opencode/background-shell';
import { opencodeClient } from '@/lib/opencode/client';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { useBackgroundShellsStore, waitForShellSettle } from '@/sync/background-shells';


const SETTLE_TIMEOUT_MS = 10_000;
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

export const isForegroundShellStopping = (shellID: string): boolean => useStoppingShells.getState().ids.has(shellID);

export const useForegroundShellStopping = (shellID: string | undefined): boolean => (
  useStoppingShells(useCallback((state) => (shellID ? state.ids.has(shellID) : false), [shellID]))
);

export const useForegroundShellStoppingIds = (): ReadonlySet<string> => useStoppingShells((state) => state.ids);

export const stopForegroundShell = async (
  params: { sessionID: string; sessionDirectory?: string | null; shell: ShellToStop },
  settleTimeoutMs = SETTLE_TIMEOUT_MS,
): Promise<void> => {
  const { shellID } = params.shell;
  const ownsRuntime = captureRuntimeInstance();
  markStopping(shellID);
  try {
    const wait = waitForShellSettle(shellID, settleTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The command did not move to the background in time.')), settleTimeoutMs);
    });
    const [, outcome] = await Promise.race([
      Promise.all([
        opencodeClient.backgroundSessionWork(params.sessionID, params.sessionDirectory),
        wait.settled,
      ]),
      deadline,
    ]).finally(() => {
      clearTimeout(timer);
      wait.cancel();
    });
    if (!ownsRuntime()) throw new Error('The runtime changed before the command was stopped.');
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
