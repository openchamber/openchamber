import { permissionModeForNewSession, type PermissionMode } from '@/stores/utils/permissionAutoAccept';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { useUIStore } from '@/stores/useUIStore';
import type { Message, Part, Session } from '@/lib/opencode/model';
import { opencodeClient, type SkillMentions } from '@/lib/opencode/client';
import * as sessionActions from '@/sync/session-actions';
import { withBtwSessionLink, withBtwSessionMarker, withoutBtwSessionLink, withoutBtwSessionMarker } from '@/lib/sessionBtwMetadata';
import { useBtwStore } from '@/stores/useBtwStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { getSyncChildStores, registerSessionDirectory } from '@/sync/sync-refs';
import { Binary } from '@/sync/binary';
import type { ContextPartMetadata } from '@/lib/messages/contextParts';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { getRuntimeKey } from '@/lib/runtime-switch';

/**
 * The composer identity a `/btw` fork takes while the fork is still being
 * created. Its text stays in memory until migration or discard; it must never
 * be persisted because the next `/btw` for this parent reuses the key.
 */
export const btwPendingComposerKey = (parentSessionId: string): string => `btw-pending:${parentSessionId}`;

export const isBtwPendingComposerKey = (sessionId: string | null | undefined): boolean =>
  Boolean(sessionId?.startsWith('btw-pending:'));

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
  expectedRuntimeKey?: string;
  question: string;
  directory: string;
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string | null;
  /** Absent: the fork is a new session and the server writes the default mode. */
  permissionMode?: PermissionMode;
  attachments?: AttachedFile[];
  additionalParts?: Array<{
    text: string;
    attachments?: AttachedFile[];
    synthetic?: boolean;
    metadata?: ContextPartMetadata;
  }>;
  /** Skills the question names inline, attached to its prompt. */
  skills?: SkillMentions;
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

/**
 * The btw framing texts a composer send carries.
 *
 * The boundary instruction rides with every send routed to an active btw fork,
 * so the inherited transcript stays reference material for the whole side
 * conversation. The promotion notice is the opposite case: it tells a promoted
 * session that the btw constraints in its own history are lifted. A send routed
 * to a fresh fork is never that session, so the two never travel together.
 */
export const buildBtwSyntheticTexts = (state: {
  isBtwActive: boolean;
  isPromotedBtwSession: boolean;
}): string[] => {
  if (state.isBtwActive) return [BTW_BOUNDARY_INSTRUCTION];
  return state.isPromotedBtwSession ? [BTW_PROMOTION_NOTICE] : [];
};

/** The boundary as an `additionalParts` entry for `sendMessage`. */
const btwBoundaryParts = (): Array<{ text: string; synthetic: true }> =>
  [{ text: BTW_BOUNDARY_INSTRUCTION, synthetic: true }];

/** A running step is the newest assistant record, behind at most a few plumbing records. */
const IN_FLIGHT_TAIL_LIMIT = 5;
const IN_FLIGHT_TEXT_LIMIT = 2000;
const IN_FLIGHT_INPUT_LIMIT = 300;
const IN_FLIGHT_RESULT_LIMIT = 1000;

const clipEnd = (text: string, limit: number): string =>
  text.length > limit ? `…${text.slice(text.length - limit)}` : text;
const clipStart = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/**
 * A text snapshot of the parent's step that is still running, for the first
 * question of a fork made mid-turn.
 *
 * OpenCode leaves an unfinished step out of a fork, because its tool calls may
 * have no result yet and a provider rejects a call without one. That step is
 * what the main thread is doing right now, which is what a `/btw` asked
 * mid-turn is usually about. As plain text in the question it reaches the
 * model without any unanswered tool call. `null` when no step is running.
 */
export const buildBtwInFlightNote = (
  records: ReadonlyArray<{ info: Message; parts: readonly Part[] }>,
): string | null => {
  const texts: string[] = [];
  const calls: string[] = [];
  const running = records
    .filter(({ info }) => info.role === 'assistant' && info.time.completed === undefined)
    .sort((a, b) => a.info.time.created - b.info.time.created);
  for (const { parts } of running) {
    for (const part of parts) {
      if (part.type === 'text' && part.text.trim()) texts.push(part.text.trim());
      if (part.type === 'tool') {
        const input = JSON.stringify(part.state.input ?? {});
        calls.push(`- ${part.tool} (${part.state.status})${input === '{}' ? '' : `: ${clipStart(input, IN_FLIGHT_INPUT_LIMIT)}`}`);
        // A call that settled while another in the same step still runs is
        // left out of the fork with its step, result included.
        const result = part.state.status === 'completed' ? part.state.output
          : part.state.status === 'error' ? part.state.error
            : '';
        if (result.trim()) calls.push(`  Result: ${clipEnd(result.trim(), IN_FLIGHT_RESULT_LIMIT)}`);
      }
    }
  }
  if (texts.length === 0 && calls.length === 0) return null;
  return [
    'When this btw session started, the main thread was in the middle of a step that is not in the inherited history. A snapshot of that step follows. It is reference only, and the main thread may have moved on since.',
    ...(texts.length > 0 ? ['Text written so far:', clipEnd(texts.join('\n\n'), IN_FLIGHT_TEXT_LIMIT)] : []),
    ...(calls.length > 0 ? ['Tool calls in that step, with their status at that moment:', ...calls] : []),
  ].join('\n');
};

export const btwSessionTitle = (question: string): string => `btw: ${question}`;

/**
 * Insert the fork into its directory child store so the sidebar picks it up
 * immediately, mirroring `forkFromMessage` in session-actions.
 */
function insertForkIntoDirectoryStore(session: Session, directory: string): void {
  // `getChild` normalizes the key: OpenCode returns native Windows paths
  // (`C:\repo`) while child stores are keyed by `C:/repo`. OpenCode 2.x
  // publishes no `session.created` for a fork, so a missed insert here leaves
  // the fork out of the store and the btw panel never appears.
  const store = getSyncChildStores().getChild(directory);
  if (!store) return;
  const current = store.getState();
  const sessions = [...current.session];
  const searchResult = Binary.search(sessions, session.id, (s) => s.id);
  if (!searchResult.found) {
    sessions.splice(searchResult.index, 0, session);
    store.setState({ session: sessions });
  }
}

/** Preparation can be discarded until the server-side fork starts. */
export async function preparePendingBtwSend(
  parentSessionId: string,
  expectedRuntimeKey: string,
  prepare: () => Promise<void>,
): Promise<symbol | null> {
  if (getRuntimeKey() !== expectedRuntimeKey) return null;
  const panels = useBtwStore.getState();
  const owner = panels.byParent[parentSessionId];
  if (!owner?.pending || owner.creating || owner.pendingSend) return null;
  const token = Symbol('btw-send');
  panels.setPanelState(parentSessionId, { pendingSend: token });
  try {
    await prepare();
  } catch (error) {
    if (useBtwStore.getState().byParent[parentSessionId]?.pendingSend === token) {
      panels.setPanelState(parentSessionId, { pendingSend: undefined });
    }
    throw error;
  }
  if (useBtwStore.getState().byParent[parentSessionId]?.pendingSend !== token) return null;
  if (getRuntimeKey() !== expectedRuntimeKey) {
    panels.clearPanelState(parentSessionId);
    return null;
  }
  return token;
}

export async function startBtwSession(input: StartBtwInput): Promise<Session> {
  const { setPanelState } = useBtwStore.getState();
  if (useBtwStore.getState().byParent[input.parentSessionId]?.creating) {
    throw new Error('btw session creation already in progress');
  }
  const expectedRuntimeKey = input.expectedRuntimeKey ?? getRuntimeKey();
  if (getRuntimeKey() !== expectedRuntimeKey) throw new Error('runtime changed');
  setPanelState(input.parentSessionId, { creating: true });
  try {
    await sessionActions.waitForConnectionOrThrow();
    if (getRuntimeKey() !== expectedRuntimeKey) throw new Error('runtime changed');
    // Fork at HEAD, so a `/btw` typed mid-turn sees the work in progress.
    // OpenCode copies only settled records into a fork: a step still running
    // (with any tool call that has no result yet), a running shell and a
    // running compaction stay behind, so the fork is always a valid
    // transcript. The step left out reaches the first question as text, read
    // from the server right before the fork: this window's view can trail it.
    const parentTail = await opencodeClient.getSessionMessages(input.parentSessionId, { limit: IN_FLIGHT_TAIL_LIMIT }, input.directory);
    if (getRuntimeKey() !== expectedRuntimeKey) throw new Error('runtime changed');
    const inFlightNote = buildBtwInFlightNote(parentTail.items);
    const forked = await opencodeClient.forkSession(input.parentSessionId, { directory: input.directory });

    // The server may canonicalize the worktree path; the prompt must use the
    // same directory identity as the forked session.
    const sessionDirectory = forked.directory || input.directory;
    try {
      if (getRuntimeKey() !== expectedRuntimeKey) throw new Error('runtime changed');
      registerSessionDirectory(forked.id, sessionDirectory);
      const selections = useSelectionStore.getState();
      selections.saveSessionModelSelection(forked.id, input.providerID, input.modelID);
      if (input.agent) {
        selections.saveSessionAgentSelection(forked.id, input.agent);
        selections.saveAgentModelForSession(forked.id, input.agent, input.providerID, input.modelID);
        selections.saveAgentModelVariantForSession(forked.id, input.agent, input.providerID, input.modelID, input.variant);
      }
      const permissionMode = permissionModeForNewSession(
        input.permissionMode,
        isSpaceDirectory(sessionDirectory),
        useUIStore.getState().permissionDefaultMode,
      );
      if (permissionMode !== undefined) {
        const { usePermissionStore } = await import('@/stores/permissionStore');
        if (getRuntimeKey() !== expectedRuntimeKey) throw new Error('runtime changed');
        const write = usePermissionStore.getState().setSessionMode(forked.id, permissionMode);
        // A mode the user picked must hold; the Settings default is best-effort, as for a draft.
        if (input.permissionMode !== undefined) await write;
        else await write.catch((error) => console.warn('Failed to apply the default permission mode to the btw fork:', error));
        if (getRuntimeKey() !== expectedRuntimeKey) throw new Error('runtime changed');
      }
      // Locate the inherited-history boundary by identity, not by ID ordering.
      const newestCloned = await opencodeClient.getSessionMessages(forked.id, { limit: 1 }, sessionDirectory);
      const boundaryMessageID = newestCloned.items[newestCloned.items.length - 1]?.info.id ?? null;

      // The fork inherits the parent's metadata and title wholesale: replace
      // the metadata with the btw marker, and rename it (rename is
      // best-effort — a failed rename must not fail the btw flow).
      // The marker lands BEFORE the fork is inserted into local stores: btw
      // forks are hidden from session lists by this marker, so inserting an
      // unmarked fork first would flash it in the sidebar.
      const marked = await sessionActions.patchSessionMetadata(forked.id, sessionDirectory, (metadata) =>
        withBtwSessionMarker(metadata, input.parentSessionId, boundaryMessageID), expectedRuntimeKey);
      // patchSessionMetadata already upserted the marked fork into the global
      // store; the directory child store still needs the explicit insert.
      insertForkIntoDirectoryStore(marked, sessionDirectory);
      void sessionActions.updateSessionTitle(forked.id, btwSessionTitle(input.question), {
        directory: sessionDirectory,
        expectedRuntimeKey,
      }).catch(() => undefined);

      // Link the parent before sending so the panel opens as soon as the
      // metadata lands; the question streams into it.
      await sessionActions.patchSessionMetadata(input.parentSessionId, input.directory, (metadata) =>
        withBtwSessionLink(metadata, forked.id), expectedRuntimeKey);

      try {
        await useSessionUIStore.getState().sendMessage(
          input.question,
          input.providerID,
          input.modelID,
          input.agent,
          input.attachments ?? [],
          undefined,
          // The very first question already needs the boundary: the fork is at
          // its most dangerous here, with the parent's in-flight plan as the
          // newest thing in its context.
          [
            ...btwBoundaryParts(),
            ...(inFlightNote ? [{ text: inFlightNote, synthetic: true }] : []),
            ...(input.additionalParts ?? []),
          ],
          input.variant ?? undefined,
          'normal',
          {
            target: { runtimeKey: expectedRuntimeKey, sessionId: forked.id, directory: sessionDirectory },
            sessionId: forked.id,
            directory: sessionDirectory,
            skills: input.skills,
          },
        );
      } catch (error) {
        // A fork without its first question is not a usable btw session:
        // unlink the parent again before deleting the fork.
        await sessionActions.patchSessionMetadata(input.parentSessionId, input.directory, (metadata) =>
          withoutBtwSessionLink(metadata, forked.id), expectedRuntimeKey).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      await sessionActions.deleteSession(forked.id, { expectedRuntimeKey }).catch(() => undefined);
      throw error;
    }
    return forked;
  } finally {
    if (getRuntimeKey() === expectedRuntimeKey) setPanelState(input.parentSessionId, { creating: false });
  }
}

/**
 * Records are a chronologically ordered suffix of the session. Keep everything
 * after the inherited-history marker; an absent marker is outside that suffix.
 * Message IDs are identities, not timestamps (including client-generated IDs).
 */
export function filterBtwTailMessages(
  records: Array<{ info: Message; parts: Part[] }>,
  boundaryMessageID: string | null,
): Array<{ info: Message; parts: Part[] }> {
  if (!boundaryMessageID) return records;
  const boundaryIndex = records.findIndex((record) => record.info.id === boundaryMessageID);
  return boundaryIndex < 0 ? records : records.slice(boundaryIndex + 1);
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
  const expectedRuntimeKey = getRuntimeKey();
  let originalForkMetadata: Parameters<typeof withoutBtwSessionMarker>[0] | null = null;
  await sessionActions.patchSessionMetadata(ref.btwSessionId, ref.directory, (metadata) => {
    originalForkMetadata = metadata;
    return withoutBtwSessionMarker(metadata);
  }, expectedRuntimeKey);
  try {
    await sessionActions.patchSessionMetadata(ref.parentSessionId, ref.directory, (metadata) =>
      withoutBtwSessionLink(metadata, ref.btwSessionId), expectedRuntimeKey);
  } catch (error) {
    const metadataToRestore = originalForkMetadata;
    if (metadataToRestore) {
      await sessionActions.patchSessionMetadata(ref.btwSessionId, ref.directory, () => metadataToRestore, expectedRuntimeKey)
        .catch(() => undefined);
    }
    throw error;
  }
  useBtwStore.getState().clearPanelState(ref.parentSessionId);
  useSessionUIStore.getState().setCurrentSession(ref.btwSessionId);
}
