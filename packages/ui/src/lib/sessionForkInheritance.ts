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
  delete next.lead;
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
  patchMetadata: (sessionId: string, updater: (metadata: Metadata) => Metadata, condition?: 'required') => Promise<void>;
  isCurrent: () => boolean;
  setPermissions: (sessionId: string, permissions: PermissionRuleset) => Promise<void>;
  readMessages: (sessionId: string) => Promise<readonly ForkMessage[]>;
}

type ForkMessage = { id: string; role: string; createdAt: number };
const PinSchema = z.looseObject({
  id: z.string(),
  createdAt: z.number(),
  role: z.enum(['user', 'assistant']),
  sessionID: z.string().optional(),
});

const messageKey = (message: { role: string; createdAt: number }) => `${message.role}:${message.createdAt}`;

function forkPinMapping(
  fork: Session,
  sourceSessionId: string,
  source: readonly ForkMessage[],
  copied: readonly ForkMessage[],
): Map<string, string | null> {
  const counts = (messages: readonly ForkMessage[]) => {
    const result = new Map<string, ForkMessage[]>();
    for (const message of messages) {
      const key = messageKey(message);
      result.set(key, [...(result.get(key) ?? []), message]);
    }
    return result;
  };
  const originals = counts(source);
  const copies = counts(copied);
  const pins = asRecord(fork.metadata?.openchamber)?.context_obligatory_messages;
  const mapping = new Map<string, string | null>();
  if (!Array.isArray(pins)) return mapping;
  for (const value of pins) {
    const parsed = PinSchema.safeParse(value);
    if (!parsed.success) continue;
    const pin = parsed.data;
    if (pin.sessionID && pin.sessionID !== sourceSessionId) continue;
    const original = source.find((message) => message.id === pin.id);
    if (!original) continue;
    const matches = originals.get(messageKey(original));
    const targets = copies.get(messageKey(original)) ?? [];
    if (matches?.length !== 1 || matches[0]?.id !== pin.id || targets.length > 1) continue;
    mapping.set(pin.id, targets[0]?.id ?? null);
  }
  return mapping;
}

function remapPins(metadata: Metadata, mapping: Map<string, string | null>, forkId: string): Metadata {
  const namespace = asRecord(metadata.openchamber);
  const pins = namespace?.context_obligatory_messages;
  if (!namespace || !Array.isArray(pins)) return metadata;
  const pinned = new Set(pins.flatMap((value) => {
    const pin = PinSchema.safeParse(value);
    return pin.success ? [pin.data.id] : [];
  }));
  let changed = false;
  const result = pins.flatMap((value) => {
    const pin = PinSchema.safeParse(value);
    if (!pin.success || !mapping.has(pin.data.id)) return [value];
    changed = true;
    const id = mapping.get(pin.data.id);
    return id && !pinned.has(id) ? [{ ...pin.data, id, sessionID: forkId }] : [];
  });
  if (!changed) return metadata;
  return { ...metadata, openchamber: { ...namespace, context_obligatory_messages: result } };
}

function hasInheritedPin(fork: Session, sourceSessionId: string): boolean {
  const pins = asRecord(fork.metadata?.openchamber)?.context_obligatory_messages;
  return Array.isArray(pins) && pins.some((value) => {
    const pin = PinSchema.safeParse(value);
    return pin.success && (!pin.data.sessionID || pin.data.sessionID === sourceSessionId);
  });
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

  try {
    if (hasSourceOwnedLinks(fork) || inlineObjective !== null) {
      await deps.patchMetadata(fork.id, (metadata) => {
        const cleaned = withoutSourceOwnedLinks(metadata);
        return goal && inlineObjective !== null ? withInlineGoalObjective(cleaned, goal.id, inlineObjective) : cleaned;
      });
    }
  } catch (error) {
    console.warn('[fork] failed to update the fork metadata', error);
  }
  if (!deps.isCurrent() || !hasInheritedPin(fork, sourceSessionId)) return;
  try {
    const [source, copied] = await Promise.all([deps.readMessages(sourceSessionId), deps.readMessages(fork.id)]);
    const pinMapping = forkPinMapping(fork, sourceSessionId, source, copied);
    if (!deps.isCurrent() || pinMapping.size === 0) return;
    await deps.patchMetadata(fork.id, (metadata) => remapPins(metadata, pinMapping, fork.id), 'required');
  } catch (error) {
    console.warn('[fork] failed to repair inherited pins', error);
  }
}
