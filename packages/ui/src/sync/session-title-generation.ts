import { create } from 'zustand';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import type { Session } from '@opencode-ai/sdk/v2';
import type { collectSessionTitleTurns } from '@/lib/sessionTitle';

type TitleTarget = { runtimeKey: string; directory: string; sessionID: string };
type PendingTitle = { target: TitleTarget; controller: AbortController };

const keyFor = (target: TitleTarget) => JSON.stringify([target.runtimeKey, normalizePath(target.directory), target.sessionID]);
const useTitleGenerations = create<{ pending: ReadonlyMap<string, PendingTitle> }>(() => ({ pending: new Map() }));

/** The metadata check belongs to the operation, independently of its menu. */
export async function generateAndSaveSessionTitle(input: {
  signal: AbortSignal;
  prepare: (signal: AbortSignal) => Promise<{ session: Session; turns: ReturnType<typeof collectSessionTitleTurns> }>;
  generate: (turns: ReturnType<typeof collectSessionTitleTurns>, signal: AbortSignal) => Promise<string>;
  readSession: () => Promise<Session>;
  saveTitle: (title: string, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const { signal } = input;
  signal.throwIfAborted();
  const { session, turns } = await input.prepare(signal);
  signal.throwIfAborted();
  if (!turns.length) throw new Error('No completed turns');
  const title = await input.generate(turns, signal);
  signal.throwIfAborted();
  const current = await input.readSession();
  signal.throwIfAborted();
  if (current.title !== session.title || current.directory !== session.directory
    || current.time.archived !== session.time.archived
    || current.revert?.messageID !== session.revert?.messageID) return;
  await input.saveTitle(title, signal);
}

export const useSessionTitleGenerationPending = (target: TitleTarget): boolean =>
  useTitleGenerations((state) => state.pending.has(keyFor(target)));

/** Manual saves invalidate generation immediately, before their HTTP write settles. */
export function cancelSessionTitleGeneration(sessionID: string, runtimeKey = getRuntimeKey()): void {
  for (const operation of useTitleGenerations.getState().pending.values()) {
    if (operation.target.sessionID === sessionID && operation.target.runtimeKey === runtimeKey) {
      operation.controller.abort();
    }
  }
}

export async function runSessionTitleGeneration(
  target: TitleTarget,
  work: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const key = keyFor(target);
  if (useTitleGenerations.getState().pending.has(key)) return;
  const controller = new AbortController();
  useTitleGenerations.setState((state) => ({ pending: new Map(state.pending).set(key, { target, controller }) }));
  const unsubscribe = subscribeRuntimeEndpointWillChange(() => controller.abort());
  try {
    if (getRuntimeKey() !== target.runtimeKey) return;
    await work(controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    unsubscribe();
    useTitleGenerations.setState((state) => {
      const pending = new Map(state.pending);
      pending.delete(key);
      return { pending };
    });
  }
}
