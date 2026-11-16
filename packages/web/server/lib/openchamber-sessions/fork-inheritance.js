import { z } from 'zod';

import { OPERATOR_CHILD_KIND } from '../session-lineage.js';
import { withoutOperatorChildDenials } from './create-session.js';

// external: https://www.npmjs.com/package/@opencode/client/v/2.3.0 OpenCode forks copy the source metadata wholesale.

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
  if (namespace.kind === 'scheduled') patch.kind = null;
  if (namespace.kind === OPERATOR_CHILD_KIND) {
    patch.kind = null;
    patch.parentID = null;
  }
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
export const applyForkInheritance = async ({ sourceSessionID, fork, readObjective, writeObjective, writeMetadata, writePermissions = null }) => {
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

  if (openChamberNamespace(metadata)?.kind === OPERATOR_CHILD_KIND && writePermissions) {
    await writePermissions(fork.id, withoutOperatorChildDenials(fork.permissions))
      .catch((error) => console.warn('[fork] failed to give the fork its question and secret tools back', error?.message ?? error));
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
