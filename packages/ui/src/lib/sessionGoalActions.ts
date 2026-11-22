import { abortCurrentOperation, patchSessionMetadata } from '@/sync/session-actions';
import { opencodeClient } from '@/lib/opencode/client';
import type { Metadata } from '@/lib/opencode/model';
import { distillGoalObjective } from '@/lib/smallModel';
import { requestGoalSpec, type GoalWriterChoice } from '@/lib/goalWriter';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { deleteGoalObjectiveFile, deleteGoalObjectiveVersion, fetchGoalObjectiveContent, fetchGoalObjectiveSnapshot, writeGoalObjectiveFile } from '@/lib/goalObjectiveFiles';
import { SESSION_GOAL_CHAR_LIMIT_MAX } from '@/lib/sessionGoalLimits';
import {
  getSessionGoal,
  type SessionGoalPayload,
  type SessionGoalStatus,
} from '@/lib/sessionGoalMetadata';
import { useUIStore } from '@/stores/useUIStore';

const isRecord = (value: unknown): value is Metadata =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const createGoalId = (): string =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const writeGoal = (
  sessionId: string,
  directory: string | undefined,
  update: (currentGoal: Metadata | null) => Metadata | null,
) =>
  patchSessionMetadata(sessionId, directory, (metadata) => {
    const namespace = isRecord(metadata.openchamber) ? metadata.openchamber : {};
    const currentGoal = isRecord(namespace.goal) ? namespace.goal : null;
    const nextGoal = update(currentGoal);
    const nextNamespace = { ...namespace };
    if (nextGoal) {
      nextNamespace.goal = nextGoal;
    } else {
      delete nextNamespace.goal;
    }
    return { ...metadata, openchamber: nextNamespace };
  });

export interface SetSessionGoalInput {
  objective: string;
  tokenBudget: number | null;
  /**
   * Run the objective through the goal writer first ("rewrite every goal").
   * `writer` is a model and effort picked for this goal and wins over
   * Settings; otherwise the writer uses the Settings model, else the
   * session's (`providerID`/`modelID`). Null keeps the objective as written.
   */
  rewrite?: { providerID?: string | null; modelID?: string | null; writer?: GoalWriterChoice | null } | null;
  /** Keep an objective longer than the limit whole instead of condensing it. */
  ignoreLimit?: boolean;
  /**
   * Start an idle session's next turn right away (`statusReason: 'resumed'`).
   * False when a message sent with the change starts that turn, so the check
   * does not first judge the last reply against the new objective.
   */
  kickoff?: boolean;
  /** Cancels the save up to the moment anything is written. */
  signal?: AbortSignal;
}

export type SetSessionGoalResult =
  /** `rewrittenSpec` is the spec the goal writer made the objective, or null when it is the text as given. */
  | { outcome: 'saved'; rewrittenSpec: string | null }
  /** The goal changed elsewhere after this edit began (completed, paused, replaced); nothing was saved. */
  | { outcome: 'changed' };

// Any goal source can exceed the objective limit (huge plans, pasted specs,
// long composer prompts). The working agent received the full text in chat;
// only the AUDITOR is bound by the limit — so oversized objectives are
// distilled into completion criteria by the small model, and on a transient
// distillation failure a head+tail excerpt keeps the intent (top) and the
// acceptance criteria (bottom), sacrificing the middle.
const TRIM_MARKER = '\n\n[… objective trimmed for the auditor — the full text was delivered in the chat message …]\n\n';

// A fixed-offset cut can land between the halves of a surrogate pair,
// leaving a lone surrogate that bakes into the stored objective as U+FFFD;
// move a boundary that lands inside a pair back to the pair boundary.
// Mirrors the excerpt twin in messages/messageMarkdown.ts.
const dropSplitHead = (text: string): string => {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
};

const dropSplitTail = (text: string): string => {
  const first = text.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
};

const fitObjective = async (raw: string, ignoreLimit: boolean): Promise<string> => {
  const limit = ignoreLimit ? SESSION_GOAL_CHAR_LIMIT_MAX : useUIStore.getState().sessionGoalObjectiveCharLimit;
  if (raw.length <= limit) {
    return raw;
  }
  if (ignoreLimit) return dropSplitHead(raw.slice(0, limit));
  const distilled = await distillGoalObjective(raw, limit);
  if (distilled) {
    return dropSplitHead(distilled.slice(0, limit));
  }
  const half = Math.max(0, Math.floor((limit - TRIM_MARKER.length) / 2));
  const dictionary = useI18nStore.getState().dictionary;
  toast.error(formatMessage(dictionary, 'chat.goal.toast.distillFallback'));
  return `${dropSplitHead(raw.slice(0, half))}${TRIM_MARKER}${dropSplitTail(raw.slice(-half))}`;
};

const rewriteObjective = async (
  raw: string,
  directory: string | undefined,
  model: NonNullable<SetSessionGoalInput['rewrite']>,
  ignoreLimit: boolean,
  signal: AbortSignal | undefined,
): Promise<string | null> => {
  const written = await requestGoalSpec({
    request: raw,
    directory,
    providerID: model.providerID,
    modelID: model.modelID,
    writer: model.writer ?? null,
    ignoreLimit,
    signal,
  });
  if (written.ok) return written.spec;
  signal?.throwIfAborted();
  // The goal still starts: the user's own text is a valid objective, and the
  // toast says it was not rewritten.
  const dictionary = useI18nStore.getState().dictionary;
  toast.error(formatMessage(dictionary, 'chat.goal.writer.toast.rewriteFailed'), { description: written.message });
  return null;
};

/** A short content hash identifying one saved objective text (FNV-1a). */
export const goalObjectiveRevision = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

/** Whether the stored goal is still the one an edit started from. */
const isSameGoal = (current: { id?: unknown; status?: unknown; objective?: unknown; objectiveFile?: unknown; objectiveRevision?: unknown; tokenBudget?: unknown; ignoreObjectiveLimit?: unknown } | null, existing: SessionGoalPayload): boolean => {
  if (current === null) return false;
  if (current.id !== existing.id || current.status !== existing.status) return false;
  // The budget and the limit flag are editable settings accounting cannot
  // change, so a difference there is another save, not a settlement bump:
  // accepting it would silently overwrite the newer setting with the
  // editor's stale value. Normalized exactly as getSessionGoal reads them.
  const currentTokenBudget = typeof current.tokenBudget === 'number' && Number.isFinite(current.tokenBudget) && current.tokenBudget > 0
    ? Math.floor(current.tokenBudget)
    : null;
  if (currentTokenBudget !== existing.tokenBudget) return false;
  if ((current.ignoreObjectiveLimit === true) !== existing.ignoreObjectiveLimit) return false;
  // updatedAt is deliberately not compared: the server runtime stamps a
  // fresh one on every accounting merge-write (token/turn settlement), so
  // routine accounting between opening the editor and saving used to read
  // as a conflicting edit. What accounting cannot change is the objective.
  if (existing.objectiveFile) {
    // The objective text lives in the file, not in this record, so the
    // record compares by revision: every save stamps the hash of the
    // objective it wrote, and accounting merge-writes preserve it. A
    // different revision means another save changed the objective while
    // this edit was open. Goals saved before revisions existed carry
    // none on one or both sides; those keep the id/status-only check.
    const currentRevision = typeof current.objectiveRevision === 'string' ? current.objectiveRevision : '';
    if (!currentRevision || !existing.objectiveRevision) return true;
    return currentRevision === existing.objectiveRevision;
  }
  const currentObjective = typeof current.objective === 'string' ? current.objective.trim() : '';
  return currentObjective === existing.objective;
};

/**
 * The goal record a save writes: the edited goal in place (id and usage kept,
 * reactivated, stale audit state cleared), a new goal, or `changed` when the
 * stored goal is no longer the one an edit started from.
 */
export const nextGoalRecord = (input: {
  currentGoal: Metadata | null;
  /** The goal an edit started from; null, or a completed goal, creates a new one. */
  existing: SessionGoalPayload | null;
  objective: string;
  objectiveFile: boolean;
  /** Revision of the full objective text being saved (see goalObjectiveRevision). */
  objectiveRevision: string;
  ignoreLimit: boolean;
  tokenBudget: number | null;
  /** `resumed` starts an idle session's next turn at once. */
  kickoff: boolean;
  now: number;
  newId: string;
}): { changed: true } | { changed: false; record: Metadata } => {
  const { currentGoal, existing, now } = input;
  if (existing && existing.status !== 'complete') {
    if (!isSameGoal(currentGoal, existing)) return { changed: true };
    return {
      changed: false,
      record: {
        ...currentGoal,
        objective: input.objective,
        objectiveFile: input.objectiveFile,
        objectiveRevision: input.objectiveRevision,
        ignoreObjectiveLimit: input.ignoreLimit,
        tokenBudget: input.tokenBudget,
        status: 'active',
        statusReason: input.kickoff ? 'resumed' : '',
        blockedStreak: 0,
        updatedAt: now,
      },
    };
  }
  return {
    changed: false,
    record: {
      id: input.newId,
      objective: input.objective,
      objectiveFile: input.objectiveFile,
      objectiveRevision: input.objectiveRevision,
      // Stated outright: a field left out would carry over from the goal this one replaces.
      ignoreObjectiveLimit: input.ignoreLimit,
      status: 'active',
      tokenBudget: input.tokenBudget,
      tokensUsed: 0,
      turnsUsed: 0,
      blockedStreak: 0,
      note: '',
      statusReason: '',
      lastAccountedMessageID: '',
      createdAt: now,
      updatedAt: now,
    },
  };
};

/**
 * Create a new goal (fresh id resets accounting) or edit the existing one
 * (id and usage counters preserved).
 *
 * An edit is saved only over the goal it started from: a rewrite can take
 * minutes, and in that time the check may complete the goal, the user may
 * pause it, or another window may replace it. Then nothing is written and the
 * result says so. The stored goal is read before the objective file is
 * written and again inside the metadata write. To keep an aborted save from
 * clobbering a change made elsewhere in between, the objective file is
 * snapshotted just before it is overwritten and restored when the metadata
 * write aborts, so the surviving goal keeps the objective text its stored
 * objectiveRevision describes (#1372).
 */
export async function setSessionGoal(
  sessionId: string,
  directory: string | undefined,
  input: SetSessionGoalInput,
  existing: SessionGoalPayload | null,
): Promise<SetSessionGoalResult> {
  const rawObjective = input.objective.trim();
  if (!rawObjective) {
    throw new Error('Goal objective must not be empty');
  }
  const ignoreLimit = input.ignoreLimit === true;
  const { signal } = input;
  const rewrittenSpec = input.rewrite ? await rewriteObjective(rawObjective, directory, input.rewrite, ignoreLimit, signal) : null;
  signal?.throwIfAborted();
  const objective = await fitObjective(rewrittenSpec ?? rawObjective, ignoreLimit);
  signal?.throwIfAborted();
  const tokenBudget = typeof input.tokenBudget === 'number' && Number.isFinite(input.tokenBudget) && input.tokenBudget > 0
    ? Math.floor(input.tokenBudget)
    : null;
  const editing = existing !== null && existing.status !== 'complete';
  if (editing && !isSameGoal(getSessionGoal(await opencodeClient.getSession(sessionId, directory)), existing)) {
    return { outcome: 'changed' };
  }
  signal?.throwIfAborted();
  // Snapshot the current objective file before overwriting it: if the
  // guarded metadata write below aborts as changed, the snapshot is restored
  // so the surviving goal record keeps pointing at its own objective text.
  // A snapshot that could not be read is not a missing file: writing anyway
  // would leave nothing truthful to restore, and the rollback below could
  // delete a file that was there all along — so the save does not start.
  const snapshot = editing ? await fetchGoalObjectiveSnapshot(sessionId) : null;
  if (snapshot?.kind === 'unavailable') {
    throw new Error('Could not read the current goal objective, so the save was not attempted. Try again.');
  }
  const priorObjective = snapshot?.kind === 'content' ? snapshot.content : null;
  // The snapshot read is asynchronous: a cancel that landed while it was in
  // flight must still stop the save before its first write.
  signal?.throwIfAborted();
  const fileWrite = await writeGoalObjectiveFile(sessionId, objective);
  if (fileWrite.saved && fileWrite.truncated) {
    const dictionary = useI18nStore.getState().dictionary;
    toast.error(formatMessage(dictionary, 'chat.goal.toast.serverTruncated'));
  }
  const objectiveFile = fileWrite.saved;
  const recordedVersionId = fileWrite.saved ? fileWrite.versionId : null;
  // Inline (the objective file failed) the text rides every session event,
  // so it stays within the limit even when the goal ignores it.
  const inline = objectiveFile ? '' : dropSplitHead(objective.slice(0, useUIStore.getState().sessionGoalObjectiveCharLimit));
  const now = Date.now();
  const newId = createGoalId();
  let changed = false;
  await writeGoal(sessionId, directory, (currentGoal) => {
    const next = nextGoalRecord({
      currentGoal,
      existing,
      objective: inline,
      objectiveFile,
      objectiveRevision: goalObjectiveRevision(objective),
      ignoreLimit,
      tokenBudget,
      kickoff: input.kickoff !== false,
      now,
      newId,
    });
    if (next.changed) {
      changed = true;
      return currentGoal;
    }
    return next.record;
  });
  if (changed && fileWrite.saved) {
    // The metadata write aborted: put the snapshotted objective file back —
    // but only while this save still owns the file. A save that committed
    // after this one wrote the file owns it now; restoring over it would
    // strand the winning save's metadata pointing at text it does not
    // describe. Ownership is read back and compared against what this save
    // wrote (a server-side truncation keeps a prefix of it). Best-effort: an
    // unreadable or no-longer-owned file is left exactly as it lies.
    const currentObjective = await fetchGoalObjectiveContent(sessionId);
    const stillOwnsFile = currentObjective !== null
      && (currentObjective === objective || objective.startsWith(currentObjective));
    if (stillOwnsFile) {
      if (priorObjective === null) {
        deleteGoalObjectiveFile(sessionId);
      } else {
        // Restoring is not a save: it puts the file back without recording a
        // version, and the version the aborted write recorded is dropped —
        // the goal never held that text, so it is not a prior version.
        await writeGoalObjectiveFile(sessionId, priorObjective, { record: false });
      }
      if (recordedVersionId) deleteGoalObjectiveVersion(sessionId, recordedVersionId);
    }
  }
  return changed ? { outcome: 'changed' } : { outcome: 'saved', rewrittenSpec };
}

export async function setSessionGoalStatus(
  sessionId: string,
  directory: string | undefined,
  status: Extract<SessionGoalStatus, 'active' | 'paused' | 'complete'>,
): Promise<void> {
  // Pausing a goal also stops the agent's current turn — same mental model
  // as the stop button, expressed through goal control. A no-op when the
  // session is already idle.
  if (status === 'paused') {
    void abortCurrentOperation(sessionId);
  }
  await writeGoal(sessionId, directory, (currentGoal) => {
    if (!currentGoal) return null;
    return {
      ...currentGoal,
      status,
      // 'resumed' is the server's kickoff signal for an already-idle session.
      statusReason: status === 'active' ? 'resumed' : (status === 'complete' ? 'marked by user' : ''),
      blockedStreak: 0,
      // An explicit resume grants a fresh auto-continuation allowance —
      // otherwise a goal blocked on the turn cap would re-block on the very
      // next tick and Resume would be a dead end.
      ...(status === 'active' ? { turnsUsed: 0 } : {}),
      updatedAt: Date.now(),
    };
  });
}

export async function clearSessionGoal(sessionId: string, directory: string | undefined): Promise<void> {
  let wasActive = false;
  await writeGoal(sessionId, directory, (currentGoal) => {
    wasActive = currentGoal?.status === 'active';
    return null;
  });
  deleteGoalObjectiveFile(sessionId);
  // Removing a running goal is a "stop" too — abort the current turn like
  // pause does. A no-op when the session is idle.
  if (wasActive) {
    void abortCurrentOperation(sessionId);
  }
}
