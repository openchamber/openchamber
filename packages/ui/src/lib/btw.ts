import type { Message, Part, Session } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import * as sessionActions from '@/sync/session-actions';
import { useBtwStore } from '@/stores/useBtwStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncChildStores, registerSessionDirectory } from '@/sync/sync-refs';
import { Binary } from '@/sync/binary';

/**
 * `/btw <question>`: fork the main session into a temporary session and send
 * the question there.
 *
 * A fork (not an empty child) gives the agent the full inherited conversation
 * as its window context. The fork is created through the SDK directly (like
 * reviewFlow) so the main chat's `currentSessionId` is never switched; the
 * prompt is routed to the fork with `SendMessageOptions.sessionId`.
 */
export type StartBtwInput = {
  parentSessionId: string;
  question: string;
  directory: string;
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
};

export const btwSessionTitle = (question: string): string => `btw: ${question}`;

/**
 * Insert the fork into its directory child store so the sidebar picks it up
 * immediately, mirroring `forkFromMessage` in session-actions.
 */
function insertForkIntoDirectoryStore(session: Session, directory: string): void {
  const store = getSyncChildStores().children.get(directory);
  if (!store) return;
  const current = store.getState();
  const sessions = [...current.session];
  const searchResult = Binary.search(sessions, session.id, (s) => s.id);
  if (!searchResult.found) {
    sessions.splice(searchResult.index, 0, session);
    store.setState({ session: sessions });
  }
}

export async function startBtwSession(input: StartBtwInput): Promise<Session | null> {
  await sessionActions.waitForConnectionOrThrow();
  const forked = await opencodeClient.forkSession(input.parentSessionId, undefined, input.directory);

  // The server may canonicalize the worktree path; the prompt must use the
  // same directory identity as the forked session.
  const sessionDirectory = (forked as { directory?: string | null }).directory ?? input.directory;
  registerSessionDirectory(forked.id, sessionDirectory);
  insertForkIntoDirectoryStore(forked, sessionDirectory);
  useGlobalSessionsStore.getState().upsertSession(forked);

  // The fork inherits the parent's title; rename it. Best-effort — a failed
  // rename must not fail the btw flow.
  const title = btwSessionTitle(input.question);
  void sessionActions.updateSessionTitle(forked.id, title).catch(() => undefined);

  const forkedAtMs = typeof forked.time?.created === 'number' ? forked.time.created : Date.now();
  useBtwStore.getState().openBtw(forked.id, sessionDirectory, title, forkedAtMs);

  try {
    await useSessionUIStore.getState().sendMessage(
      input.question,
      input.providerID,
      input.modelID,
      input.agent,
      [],
      undefined,
      undefined,
      input.variant,
      'normal',
      { sessionId: forked.id, directory: sessionDirectory },
    );
  } catch (error) {
    // A fork without its first question is not a usable btw session. Roll back
    // only if this fork still owns the panel; if the user already closed it,
    // that close already started deletion and must not affect a newer panel.
    if (useBtwStore.getState().panel.sessionId === forked.id) {
      useBtwStore.getState().closeBtw();
      await destroyBtwSession(forked.id);
    }
    throw error;
  }
  return forked;
}

/**
 * Keep only the fork's own tail: messages created at or after the fork's
 * creation time. The inherited history keeps its original (older) timestamps,
 * so this cleanly drops everything copied from the parent.
 */
export function filterBtwTailMessages(
  records: Array<{ info: Message; parts: Part[] }>,
  forkedAtMs: number,
): Array<{ info: Message; parts: Part[] }> {
  return records.filter((record) => {
    const created = record.info.time?.created;
    return typeof created === 'number' && created >= forkedAtMs;
  });
}

/** Destroy the temporary fork. Close = destroy; no keep action exists. */
export async function destroyBtwSession(sessionId: string): Promise<boolean> {
  return sessionActions.deleteSession(sessionId);
}

/**
 * Close the panel and destroy the open fork. The panel disappears
 * immediately; deletion runs in the background and reports failure through
 * `onDestroyFailed` (e.g. a toast) when the server could not confirm it.
 */
export function closeBtwPanel(onDestroyFailed?: () => void): void {
  const { sessionId } = useBtwStore.getState().panel;
  useBtwStore.getState().closeBtw();
  if (!sessionId) return;
  void destroyBtwSession(sessionId).then((ok) => {
    if (!ok) onDestroyFailed?.();
  });
}
