import { z } from 'zod';
import type { JsonValue, Metadata, Session } from '@/lib/opencode/model';
import { getSessionGoal } from '@/lib/sessionGoalMetadata';

/**
 * What a user fork (fork from message, fork after answer, `/fork`) keeps from
 * its source session's OpenChamber metadata.
 *
 * OpenCode 2.x copies the source's `metadata` wholesale into the fork, so the
 * goal already arrives with it. Two things still need repair:
 *
 * - Links that belong to the source, not to its content: the source's active
 *   btw fork (`btwSessionID`), its review session (`reviewSessionID`), and a
 *   btw marker when the source itself is a btw side thread. A fork that kept
 *   them would open the source's btw panel, delete the source's btw fork with
 *   itself, or hide from the sidebar as a btw thread.
 * - A file-backed goal objective: the text lives in a server file keyed by the
 *   session id, so the fork has no file of its own until one is copied.
 *
 * `/btw` forks do not go through here: they replace the inherited namespace
 * with their own marker (see `withBtwSessionMarker`).
 */

const MetadataRecordSchema = z.record(z.string(), z.json());

const asRecord = (value: JsonValue | undefined): Metadata | null => {
  const parsed = MetadataRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** Source-owned keys removed from the fork; everything else is kept as copied. */
export function withoutSourceOwnedLinks(metadata: Metadata): Metadata {
  const namespace = asRecord(metadata.openchamber);
  if (!namespace) return metadata;
  const next: Metadata = { ...namespace };
  delete next.btwSessionID;
  delete next.reviewSessionID;
  if (next.kind === 'btw') {
    delete next.kind;
    delete next.originalSessionID;
    delete next.btwBoundaryMessageID;
  }
  // A fork usually tries another path; it must not pursue the source's goal in
  // parallel, so an active goal arrives paused and the user resumes it.
  const goal = asRecord(next.goal);
  const pausedGoal = goal?.status === 'active';
  if (goal && pausedGoal) {
    next.goal = { ...goal, status: 'paused', statusReason: 'paused in fork' };
  }
  if (!pausedGoal && Object.keys(next).length === Object.keys(namespace).length) return metadata;
  const result: Metadata = { ...metadata };
  if (Object.keys(next).length > 0) {
    result.openchamber = next;
  } else {
    delete result.openchamber;
  }
  return result;
}

/** Turn the fork's file-backed goal into an inline one carrying `objective`. */
function withInlineGoalObjective(metadata: Metadata, goalId: string, objective: string): Metadata {
  const namespace = asRecord(metadata.openchamber);
  const goal = namespace ? asRecord(namespace.goal) : null;
  if (!namespace || !goal || goal.id !== goalId) return metadata;
  return {
    ...metadata,
    openchamber: { ...namespace, goal: { ...goal, objective, objectiveFile: false } },
  };
}

export interface ForkInheritanceDeps {
  /** The fork's current goal id, read from the authoritative session record. */
  readGoalId: (sessionId: string) => Promise<string | null>;
  readObjective: (sessionId: string) => Promise<string | null>;
  writeObjective: (sessionId: string, content: string) => Promise<boolean>;
  patchMetadata: (sessionId: string, updater: (metadata: Metadata) => Metadata) => Promise<void>;
}

const hasSourceOwnedLinks = (fork: Session): boolean =>
  fork.metadata !== undefined && withoutSourceOwnedLinks(fork.metadata) !== fork.metadata;

/**
 * Repair a freshly created fork's metadata. Best-effort: the fork already
 * exists and is usable, so every failure is logged and swallowed.
 */
export async function applyForkInheritance(
  sourceSessionId: string,
  fork: Session,
  deps: ForkInheritanceDeps,
): Promise<void> {
  const goal = getSessionGoal(fork);
  let inlineObjective: string | null = null;
  if (goal?.objectiveFile) {
    try {
      const content = await deps.readObjective(sourceSessionId);
      if (content === null) {
        // Nothing to copy: the goal keeps its inline fallback, same as a
        // source whose file went missing.
        console.warn('[fork] source goal objective unavailable; fork keeps the inline fallback');
      } else if ((await deps.readGoalId(fork.id)) !== goal.id) {
        // The user armed a new goal on the fork meanwhile; its objective file
        // is newer than the source's and must not be overwritten.
        console.warn('[fork] fork goal changed before the objective copy; skipping it');
      } else if (!(await deps.writeObjective(fork.id, content))) {
        inlineObjective = content;
      }
    } catch (error) {
      console.warn('[fork] failed to copy the goal objective to the fork', error);
    }
  }

  if (!hasSourceOwnedLinks(fork) && inlineObjective === null) return;
  try {
    await deps.patchMetadata(fork.id, (metadata) => {
      const cleaned = withoutSourceOwnedLinks(metadata);
      return goal && inlineObjective !== null ? withInlineGoalObjective(cleaned, goal.id, inlineObjective) : cleaned;
    });
  } catch (error) {
    console.warn('[fork] failed to update the fork metadata', error);
  }
}
