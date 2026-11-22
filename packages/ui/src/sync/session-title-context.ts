import type { Message, Part } from "@/lib/opencode/model"
import { collectSessionTitleTurns } from '@/lib/sessionTitle';
import type { SessionMessageLoader, SessionMessageTarget } from './session-message-loader';

/**
 * Pages the title walk may fetch before it gives up. Three turns sit
 * within a page or two of history, so 20 is far past any legitimate
 * search; without a cap, a source that keeps answering with ever-new
 * cursors loops this walk (and the history it retains) forever.
 */
const TITLE_TURNS_MAX_PAGES = 20;

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
  let pages = 0;
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
    pages += 1;
    if (pages > TITLE_TURNS_MAX_PAGES) throw new Error('Session history pagination exceeded the page limit');
    await loader.loadOlder(target);
  }
}
