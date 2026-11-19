import { z } from 'zod';

import { OPERATOR_CHILD_KIND } from '../session-lineage.js';
import { withoutOperatorChildDenials } from './create-session.js';
import { hasMessage } from './contracts.js';
import type { SessionInfo, SessionUpdateInput } from '@opencode/client';

const NamespaceSchema = z.looseObject({
  btwSessionID: z.unknown().optional(),
  reviewSessionID: z.unknown().optional(),
  kind: z.unknown().optional(),
  goal: z.unknown().optional(),
});
const FileBackedGoalSchema = z.looseObject({ id: z.string().min(1), objectiveFile: z.literal(true) });

const openChamberNamespace = (metadata: SessionInfo['metadata']) => {
  const parsed = z.looseObject({ openchamber: NamespaceSchema }).safeParse(metadata);
  return parsed.success ? parsed.data.openchamber : null;
};

interface ForkGoalPatch {
  status?: 'paused';
  statusReason?: string;
  objective?: string;
  objectiveFile?: false;
}

interface ForkNamespacePatch {
  [key: string]: null | ForkGoalPatch;
  goal?: ForkGoalPatch;
}

const isActiveGoal = (value: unknown): value is { status: 'active' } =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && 'status' in value && value.status === 'active';

export const sourceOwnedLinksPatch = (metadata: SessionInfo['metadata']) => {
  const namespace = openChamberNamespace(metadata);
  if (!namespace) return null;
  const patch: ForkNamespacePatch = {};
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
  if (goal && isActiveGoal(goal)) {
    patch.goal = { status: 'paused', statusReason: 'paused in fork' };
  }
  return Object.keys(patch).length > 0 ? patch : null;
};

const fileBackedGoal = (metadata: SessionInfo['metadata']) => {
  const parsed = FileBackedGoalSchema.safeParse(openChamberNamespace(metadata)?.goal);
  return parsed.success ? parsed.data : null;
};

interface ForkInheritanceOptions<ObjectiveResult, MetadataResult, PermissionsResult> {
  sourceSessionID: string;
  fork: Pick<SessionInfo, 'id' | 'metadata' | 'permissions'>;
  readObjective: (sessionID: string) => Promise<string | null>;
  writeObjective: (sessionID: string, content: string) => Promise<ObjectiveResult>;
  writeMetadata: (sessionID: string, patch: { openchamber: ForkNamespacePatch }) => Promise<MetadataResult>;
  writePermissions?: ((sessionID: string, permissions: SessionUpdateInput['permissions']) => Promise<PermissionsResult>) | null;
}

export const applyForkInheritance = async <ObjectiveResult, MetadataResult, PermissionsResult>({ sourceSessionID, fork, readObjective, writeObjective, writeMetadata, writePermissions = null }: ForkInheritanceOptions<ObjectiveResult, MetadataResult, PermissionsResult>) => {
  const metadata = fork?.metadata;
  const goal = fileBackedGoal(metadata);
  let inlineObjective: string | null = null;
  if (goal) {
    try {
      const content = await readObjective(sourceSessionID);
      if (content === null) {
        console.warn('[fork] source goal objective unavailable; fork keeps the inline fallback');
      } else {
        try {
          await writeObjective(fork.id, content);
        } catch (error) {
          console.warn('[fork] failed to copy the goal objective file; inlining it', (hasMessage(error) ? error.message : undefined) ?? error);
          inlineObjective = content;
        }
      }
    } catch (error) {
      console.warn('[fork] failed to read the source goal objective', (hasMessage(error) ? error.message : undefined) ?? error);
    }
  }

  if (openChamberNamespace(metadata)?.kind === OPERATOR_CHILD_KIND && writePermissions) {
    await writePermissions(fork.id, withoutOperatorChildDenials(fork.permissions))
      .catch((cause: unknown) => console.warn('[fork] failed to give the fork its question and secret tools back', (hasMessage(cause) ? cause.message : undefined) ?? cause));
  }
  const namespacePatch = sourceOwnedLinksPatch(metadata) ?? {};
  if (inlineObjective !== null) {
    namespacePatch.goal = { ...namespacePatch.goal, objective: inlineObjective, objectiveFile: false };
  }
  if (Object.keys(namespacePatch).length === 0) return;
  try {
    await writeMetadata(fork.id, { openchamber: namespacePatch });
  } catch (error) {
    console.warn('[fork] failed to update the fork metadata', (hasMessage(error) ? error.message : undefined) ?? error);
  }
};
