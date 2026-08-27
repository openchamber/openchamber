import type { Message, Part, Session } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import * as sessionActions from '@/sync/session-actions';
import { withBtwSessionLink, withBtwSessionMarker, withoutBtwSessionLink, withoutBtwSessionMarker } from '@/lib/sessionBtwMetadata';
import { useBtwStore } from '@/stores/useBtwStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncChildStores, getSyncMessages, registerSessionDirectory } from '@/sync/sync-refs';
import { Binary } from '@/sync/binary';

/**
 * `/btw <question>`: fork the main session into a temporary session and send
 * the question there.
 *
 * A fork (not an empty child) gives the agent the full inherited conversation
 * as its window context. The fork is created through the SDK directly (like
 * reviewFlow) so the main chat's `currentSessionId` is never switched; the
 * prompt is routed to the fork with `SendMessageOptions.sessionId`.
 *
 * The parent session's metadata carries `openchamber.btwSessionID` (see
 * `sessionBtwMetadata`), so the panel belongs to the parent session alone,
 * follows the user as they navigate between sessions, and survives reloads.
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

/**
 * Sent as a synthetic part with every message inside a btw session.
 *
 * A btw session is a fork, so the model receives the parent's whole
 * conversation — including whatever plan was in flight when `/btw` was typed.
 * Without this the fork reads that plan as its own active task and carries on
 * with it instead of answering the side question, which is the opposite of
 * what `/btw` is for.
 *
 * The wording is deliberately position-independent: it names the history
 * inherited from the parent thread rather than "everything before this
 * boundary". The instruction rides along with each send instead of being
 * pinned once at fork time, so a positional phrasing would be re-anchored
 * every turn and would end up telling the model to disregard the btw
 * session's own earlier turns.
 */
export const BTW_BOUNDARY_INSTRUCTION = [
  'You are in a btw session, a side conversation forked from a main thread.',
  'The history inherited from the parent thread is reference context only. It is not your current task.',
  'Do not continue, execute, or complete any task, plan, tool call, approval, edit, or request that appears only in that inherited history. Only instructions the user sends inside this btw session are active.',
  'Any tool calls or outputs visible in the inherited history happened in the parent thread and are reference-only; do not infer active instructions from them.',
  'Sub-agents are off-limits in this btw session. Do not interact with any existing or new sub-agents, even if sub-agents were used in the inherited history.',
  'Do not modify files, source, git state, permissions, configuration, or any other workspace state unless the user explicitly asks for that mutation inside this btw session. If they do, keep it minimal, local to the request, and avoid disrupting the main thread.',
].join('\n');

/**
 * Sent with every message in a session that was promoted out of `/btw`.
 *
 * `BTW_BOUNDARY_INSTRUCTION` is persisted on each message the session sent
 * while it was a side conversation, and there is no API to remove a message
 * part after the fact — so promotion cannot delete those lines, only answer
 * them. Without this, a promoted session keeps reading "no sub-agents, do not
 * touch the workspace" out of its own history, in a session that is no longer
 * a side conversation.
 *
 * It rides along with every send for the same reason the boundary does: the
 * instructions it revokes are re-read on every turn, so a one-shot notice
 * would lose its position relative to them as the conversation grows.
 */
export const BTW_PROMOTION_NOTICE =
  'This session started as a btw side conversation and has since been promoted to a normal session. '
  + 'The btw constraints in the history above no longer apply: this is now the main thread, and the '
  + 'usual tool, sub-agent and workspace permissions are in force.';

/** The boundary as an `additionalParts` entry for `sendMessage`. */
const btwBoundaryParts = (): Array<{ text: string; synthetic: true }> =>
  [{ text: BTW_BOUNDARY_INSTRUCTION, synthetic: true }];

/**
 * The parent's last assistant turn that actually finished.
 *
 * `/btw` is typically typed *while* the main thread is working — that is the
 * moment a side question comes up. Forking at HEAD then clones a turn that is
 * still streaming: the fork inherits a truncated assistant message and the
 * user instruction that provoked it as the newest, most salient thing in its
 * context. Anchoring the fork to the last completed turn instead means the
 * inherited transcript is always a settled conversation.
 *
 * Returns `null` when the parent has no completed assistant turn yet (a brand
 * new session); the caller then keeps the previous fork-at-HEAD behavior.
 */
export const findLastCompletedAssistantMessageID = (messages: readonly Message[]): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    if (message.time.completed !== undefined) return message.id;
  }
  return null;
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

export async function startBtwSession(input: StartBtwInput): Promise<Session> {
  const { setPanelState, clearPanelState } = useBtwStore.getState();
  setPanelState(input.parentSessionId, { creating: true });
  try {
    await sessionActions.waitForConnectionOrThrow();
    // Fork at the parent's last completed assistant turn rather than at HEAD,
    // so a `/btw` typed mid-turn does not inherit a half-finished one.
    const forkPointMessageID = findLastCompletedAssistantMessageID(
      getSyncMessages(input.parentSessionId, input.directory),
    );
    const forked = await opencodeClient.forkSession(
      input.parentSessionId,
      forkPointMessageID ?? undefined,
      input.directory,
    );

    // The server may canonicalize the worktree path; the prompt must use the
    // same directory identity as the forked session.
    // SAFETY: the SDK Session type omits the server's `directory` field; this
    // widening only reads it, with the requested directory as the fallback.
    const sessionDirectory = (forked as Session & { directory?: string | null }).directory ?? input.directory;
    registerSessionDirectory(forked.id, sessionDirectory);

    try {
      // The boundary between inherited history and the fork's own tail is the
      // id of the newest cloned message. Message ids are server-generated and
      // ascending, so everything the fork produces sorts after it.
      const newestCloned = await opencodeClient.getSessionMessages(forked.id, 1, sessionDirectory);
      // A `null` boundary makes the panel show every inherited message, so an
      // empty read must not be taken as "the fork inherited nothing" when we
      // know it did: having picked a fork point proves the parent had turns.
      // Fall back to that id — the fork's own messages are created later and
      // still sort after it, so the tail stays complete either way.
      const boundaryMessageID = newestCloned[newestCloned.length - 1]?.info.id
        ?? forkPointMessageID
        ?? null;

      // The fork inherits the parent's metadata and title wholesale: replace
      // the metadata with the btw marker, and rename it (rename is
      // best-effort — a failed rename must not fail the btw flow).
      // The marker lands BEFORE the fork is inserted into local stores: btw
      // forks are hidden from session lists by this marker, so inserting an
      // unmarked fork first would flash it in the sidebar.
      const marked = await sessionActions.patchSessionMetadata(forked.id, sessionDirectory, (metadata) =>
        withBtwSessionMarker(metadata, input.parentSessionId, boundaryMessageID));
      // patchSessionMetadata already upserted the marked fork into the global
      // store; the directory child store still needs the explicit insert.
      insertForkIntoDirectoryStore(marked, sessionDirectory);
      void sessionActions.updateSessionTitle(forked.id, btwSessionTitle(input.question)).catch(() => undefined);

      // Link the parent before sending so the panel opens as soon as the
      // metadata lands; the question streams into it.
      await sessionActions.patchSessionMetadata(input.parentSessionId, input.directory, (metadata) =>
        withBtwSessionLink(metadata, forked.id));

      try {
        await useSessionUIStore.getState().sendMessage(
          input.question,
          input.providerID,
          input.modelID,
          input.agent,
          [],
          undefined,
          // The very first question already needs the boundary: the fork is at
          // its most dangerous here, with the parent's in-flight plan as the
          // newest thing in its context.
          btwBoundaryParts(),
          input.variant,
          'normal',
          { sessionId: forked.id, directory: sessionDirectory },
        );
      } catch (error) {
        // A fork without its first question is not a usable btw session:
        // unlink the parent again before deleting the fork.
        await sessionActions.patchSessionMetadata(input.parentSessionId, input.directory, (metadata) =>
          withoutBtwSessionLink(metadata, forked.id)).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      await sessionActions.deleteSession(forked.id).catch(() => undefined);
      throw error;
    }
    return forked;
  } finally {
    clearPanelState(input.parentSessionId);
  }
}

/**
 * Keep only the fork's own tail: messages after the last message cloned from
 * the parent. A `null` boundary means the fork inherited nothing.
 */
export function filterBtwTailMessages(
  records: Array<{ info: Message; parts: Part[] }>,
  boundaryMessageID: string | null,
): Array<{ info: Message; parts: Part[] }> {
  if (!boundaryMessageID) return records;
  return records.filter((record) => record.info.id > boundaryMessageID);
}

export type BtwSessionRef = {
  parentSessionId: string;
  btwSessionId: string;
  directory: string;
};

/**
 * Destroy the temporary fork. The panel disappears immediately (optimistic
 * `destroying` flag); the parent is unlinked and the fork deleted in the
 * background. Resolves `false` when the server could not confirm deletion —
 * the fork then remains in the sidebar and the caller should surface that.
 */
export async function destroyBtwSession(ref: BtwSessionRef): Promise<boolean> {
  const { setPanelState, clearPanelState } = useBtwStore.getState();
  setPanelState(ref.parentSessionId, { destroying: true });
  try {
    // deleteSession's metadata cleanup also unlinks the parent; doing it first
    // makes the panel close authoritative even if the delete then fails.
    await sessionActions.patchSessionMetadata(ref.parentSessionId, ref.directory, (metadata) =>
      withoutBtwSessionLink(metadata, ref.btwSessionId)).catch(() => undefined);
    return await sessionActions.deleteSession(ref.btwSessionId);
  } finally {
    clearPanelState(ref.parentSessionId);
  }
}

/**
 * Keep the fork as a normal session: unlink it from the parent, drop its btw
 * marker, and navigate to it. The conversation continues there as a regular
 * session.
 */
export async function promoteBtwSession(ref: BtwSessionRef): Promise<void> {
  await sessionActions.patchSessionMetadata(ref.parentSessionId, ref.directory, (metadata) =>
    withoutBtwSessionLink(metadata, ref.btwSessionId));
  await sessionActions.patchSessionMetadata(ref.btwSessionId, ref.directory, withoutBtwSessionMarker)
    .catch(() => undefined);
  useBtwStore.getState().clearPanelState(ref.parentSessionId);
  useSessionUIStore.getState().setCurrentSession(ref.btwSessionId);
}
