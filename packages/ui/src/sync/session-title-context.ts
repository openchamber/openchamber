import type { Message, Part } from '@opencode-ai/sdk/v2';
import { collectSessionTitleTurns } from '@/lib/sessionTitle';
import type { SessionMessageLoader, SessionMessageTarget } from './session-message-loader';

/** Share the normal loader's requests, stopping as soon as three pairs are covered. */
export async function loadSessionTitleTurns(input: {
  loader: Pick<SessionMessageLoader, 'getSnapshot' | 'ensure' | 'loadOlder'>;
  target: SessionMessageTarget;
  getRecords: () => { info: Message; parts: Part[] }[];
  revertMessageID?: string;
  signal: AbortSignal;
}) {
  const { loader, target, signal } = input;
  signal.throwIfAborted();
  const initial = loader.getSnapshot(target);
  await loader.ensure(target, { force: !initial.resolved || initial.status === 'error' });
  signal.throwIfAborted();
  const generation = loader.getSnapshot(target).generation;
  const visited = new Set<string>();
  while (true) {
    signal.throwIfAborted();
    const state = loader.getSnapshot(target);
    if (state.status !== 'ready' || state.generation !== generation) {
      throw state.error ?? new Error('Session history is unavailable');
    }
    const turns = collectSessionTitleTurns(input.getRecords(), input.revertMessageID);
    if (turns.length === 3 || state.complete) return turns;
    if (!state.cursor || visited.has(state.cursor)) throw new Error('Session history pagination made no progress');
    visited.add(state.cursor);
    await loader.loadOlder(target);
  }
}
