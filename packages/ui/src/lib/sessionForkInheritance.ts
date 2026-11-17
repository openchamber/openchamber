import { z } from 'zod';
import type { JsonValue, Metadata, PermissionRuleset, Session } from '@/lib/opencode/model';
import { isOperatorChildSession, permissionsAfterTakeOver } from '@/lib/sessionOperatorChild';
import { getSessionGoal } from '@/lib/sessionGoalMetadata';


const MetadataRecordSchema = z.record(z.string(), z.json());

const asRecord = (value: JsonValue | undefined): Metadata | null => {
  const parsed = MetadataRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

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
  if (next.kind === 'scheduled') delete next.kind;
  if (next.kind === 'operator-child') {
    delete next.kind;
    delete next.parentID;
  }
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
  readGoalId: (sessionId: string) => Promise<string | null>;
  readObjective: (sessionId: string) => Promise<string | null>;
  writeObjective: (sessionId: string, content: string) => Promise<boolean>;
  patchMetadata: (sessionId: string, updater: (metadata: Metadata) => Metadata) => Promise<void>;
  setPermissions: (sessionId: string, permissions: PermissionRuleset) => Promise<void>;
}

const hasSourceOwnedLinks = (fork: Session): boolean =>
  fork.metadata !== undefined && withoutSourceOwnedLinks(fork.metadata) !== fork.metadata;

export async function applyForkInheritance(
  sourceSessionId: string,
  fork: Session,
  deps: ForkInheritanceDeps,
): Promise<void> {
  if (isOperatorChildSession(fork)) {
    await deps.setPermissions(fork.id, permissionsAfterTakeOver(fork.permissions))
      .catch((error) => console.warn('[fork] failed to give the fork its question tool back', error));
  }
  const goal = getSessionGoal(fork);
  let inlineObjective: string | null = null;
  if (goal?.objectiveFile) {
    try {
      const content = await deps.readObjective(sourceSessionId);
      if (content === null) {
        console.warn('[fork] source goal objective unavailable; fork keeps the inline fallback');
      } else if ((await deps.readGoalId(fork.id)) !== goal.id) {
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
