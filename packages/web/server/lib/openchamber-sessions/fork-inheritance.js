import { z } from 'zod';

/**
 * What a fork made through the OpenChamber sessions API (CLI, scheduled tasks)
 * keeps from its source session's OpenChamber metadata. Server twin of the UI's
 * `packages/ui/src/lib/sessionForkInheritance.ts`: UI forks call OpenCode
 * directly and repair themselves; forks made here are repaired here.
 *
 * OpenCode 2.x copies the source's `metadata` wholesale into the fork, so the
 * goal already arrives. Two repairs remain:
 *
 * - Source-owned links: the source's btw fork (`btwSessionID`), its review
 *   session (`reviewSessionID`), and the btw marker when the source is itself a
 *   btw side thread.
 * - A file-backed goal objective: the text lives in a file keyed by the session
 *   id, so the fork needs its own copy. When the copy cannot be written the
 *   fork's goal carries the text inline instead.
 */

const NamespaceSchema = z.looseObject({
  btwSessionID: z.unknown().optional(),
  reviewSessionID: z.unknown().optional(),
  kind: z.unknown().optional(),
  goal: z.unknown().optional(),
});
const FileBackedGoalSchema = z.looseObject({ id: z.string().min(1), objectiveFile: z.literal(true) });

const openChamberNamespace = (metadata) => {
  const parsed = z.looseObject({ openchamber: NamespaceSchema }).safeParse(metadata);
  return parsed.success ? parsed.data.openchamber : null;
};

/** Merge patch (RFC 7386) removing source-owned links; null when there are none. */
export const sourceOwnedLinksPatch = (metadata) => {
  const namespace = openChamberNamespace(metadata);
  if (!namespace) return null;
  const patch = {};
  for (const key of ['btwSessionID', 'reviewSessionID']) {
    if (key in namespace) patch[key] = null;
  }
  if (namespace.kind === 'btw') {
    for (const key of ['kind', 'originalSessionID', 'btwBoundaryMessageID']) {
      if (key in namespace) patch[key] = null;
    }
  }
  // A fork must not pursue the source's goal in parallel: an active goal
  // arrives paused and the user resumes it (same rule as UI forks).
  const goal = namespace.goal;
  if (goal && typeof goal === 'object' && !Array.isArray(goal) && goal.status === 'active') {
    patch.goal = { status: 'paused', statusReason: 'paused in fork' };
  }
  return Object.keys(patch).length > 0 ? patch : null;
};

const fileBackedGoal = (metadata) => {
  const parsed = FileBackedGoalSchema.safeParse(openChamberNamespace(metadata)?.goal);
  return parsed.success ? parsed.data : null;
};

/**
 * Repair a freshly created fork. Best-effort: the fork already exists and is
 * usable, so every failure is logged and swallowed.
 *
 * @param {object} options
 * @param {string} options.sourceSessionID
 * @param {{ id: string, metadata?: object }} options.fork The fork record OpenCode returned.
 * @param {(sessionID: string) => Promise<string | null>} options.readObjective
 * @param {(sessionID: string, content: string) => Promise<unknown>} options.writeObjective Throws on failure.
 * @param {(sessionID: string, patch: object) => Promise<unknown>} options.writeMetadata
 */
export const applyForkInheritance = async ({ sourceSessionID, fork, readObjective, writeObjective, writeMetadata }) => {
  const metadata = fork?.metadata;
  const goal = fileBackedGoal(metadata);
  let inlineObjective = null;
  if (goal) {
    try {
      const content = await readObjective(sourceSessionID);
      if (content === null) {
        console.warn('[fork] source goal objective unavailable; fork keeps the inline fallback');
      } else {
        try {
          await writeObjective(fork.id, content);
        } catch (error) {
          console.warn('[fork] failed to copy the goal objective file; inlining it', error?.message ?? error);
          inlineObjective = content;
        }
      }
    } catch (error) {
      console.warn('[fork] failed to read the source goal objective', error?.message ?? error);
    }
  }

  const namespacePatch = sourceOwnedLinksPatch(metadata) ?? {};
  if (inlineObjective !== null) {
    namespacePatch.goal = { ...namespacePatch.goal, objective: inlineObjective, objectiveFile: false };
  }
  if (Object.keys(namespacePatch).length === 0) return;
  try {
    await writeMetadata(fork.id, { openchamber: namespacePatch });
  } catch (error) {
    console.warn('[fork] failed to update the fork metadata', error?.message ?? error);
  }
};
