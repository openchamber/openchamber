import { useCallback } from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { generateSessionTitle } from '@/lib/sessionTitle';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isVSCodeRuntime } from '@/lib/desktop';
import { normalizePath } from '@/lib/pathNormalization';
import { buildSessionMessageRecordsSnapshot, useSyncRuntime } from './sync-context';
import { loadSessionTitleTurns } from './session-title-context';
import { generateAndSaveSessionTitle, runSessionTitleGeneration, useSessionTitleGenerationPending } from './session-title-generation';
import { updateSessionTitle } from './session-actions';

export function useIsSessionAiRenamePending(sessionID: string, directory: string | null | undefined): boolean {
  const { runtimeKey } = useSyncRuntime();
  return useSessionTitleGenerationPending({ runtimeKey, sessionID, directory: directory ?? '' });
}

export function useSessionAiRename(sessionID: string, directory: string | null | undefined) {
  const { runtimeKey, childStores, messageLoader } = useSyncRuntime();

  const prepare = useCallback(async (signal: AbortSignal) => {
    if (!directory || isVSCodeRuntime()) throw new Error('Session title generation is unavailable');
    signal.throwIfAborted();
    if (getRuntimeKey() !== runtimeKey) throw new Error('Runtime changed');
    const session = await opencodeClient.getSession(sessionID, directory);
    signal.throwIfAborted();
    if (getRuntimeKey() !== runtimeKey || normalizePath(session.directory) !== normalizePath(directory)) {
      throw new Error('Session moved');
    }
    const store = childStores.ensureChild(directory, { bootstrap: false });
    const turns = await loadSessionTitleTurns({
      loader: messageLoader,
      target: { directory, sessionID },
      getRecords: () => buildSessionMessageRecordsSnapshot(store.getState(), sessionID).list,
      revertMessageID: session.revert?.messageID,
      signal,
    });
    signal.throwIfAborted();
    if (getRuntimeKey() !== runtimeKey) throw new Error('Runtime changed');
    return { session, turns };
  }, [childStores, directory, messageLoader, runtimeKey, sessionID]);

  const rename = useCallback(async () => {
    if (!directory) return;
    await runSessionTitleGeneration({ runtimeKey, directory, sessionID }, async (signal) => {
      await generateAndSaveSessionTitle({
        signal,
        prepare,
        generate: (turns, requestSignal) => generateSessionTitle({ turns, directory, sessionID, signal: requestSignal }),
        readSession: () => opencodeClient.getSession(sessionID, directory),
        saveTitle: (title, requestSignal) => updateSessionTitle(sessionID, title, { directory, expectedRuntimeKey: runtimeKey, signal: requestSignal }),
      });
    });
  }, [directory, prepare, runtimeKey, sessionID]);

  return { prepare, rename };
}
