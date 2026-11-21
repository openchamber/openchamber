import { ClientError } from '@opencode/client';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

import { OPERATOR_CHILD_KIND } from '../session-lineage.js';
import { withoutOperatorChildDenials } from './create-session.js';
import { hasMessage } from './contracts.js';
import type { SessionInfo, SessionUpdateInput } from '@opencode/client';
import type { MetadataDecider } from './session-metadata-store.js';
import type { SessionClient } from './opencode-client-contract.js';

const NamespaceSchema = z.looseObject({
  btwSessionID: z.unknown().optional(),
  reviewSessionID: z.unknown().optional(),
  kind: z.unknown().optional(),
  goal: z.unknown().optional(),
});
const FileBackedGoalSchema = z.looseObject({ id: z.string().min(1), objectiveFile: z.literal(true) });
const PinSchema = z.looseObject({
  id: z.string(),
  createdAt: z.number(),
  role: z.enum(['user', 'assistant']),
  sessionID: z.string().optional(),
});
const PinsMetadataSchema = z.looseObject({
  openchamber: z.looseObject({ context_obligatory_messages: z.array(z.unknown()) }),
});

type ForkMessage = { id: string; role: string; createdAt: number };
export const listForkMessages = async (client: SessionClient, sessionID: string): Promise<ForkMessage[]> => {
  const messages: ForkMessage[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const query = { sessionID, limit: 100, ...(cursor ? { cursor } : { order: 'asc' as const }) };
    const page = await client.message.list(query).catch(async (error) => {
      if (!(error instanceof ClientError) || error.reason !== 'UnexpectedStatus'
        || !/^UnexpectedStatus: 50[234]$/.test(error.message)) throw error;
      await delay(500);
      return client.message.list(query);
    });
    for (const message of page.data) {
      messages.push({ id: message.id, role: message.type, createdAt: message.time.created });
    }
    cursor = page.data.length < 100 ? undefined : page.cursor?.next ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error('repeated message cursor');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return messages;
};
const messageKey = (message: { role: string; createdAt: number }) => `${message.role}:${message.createdAt}`;

function forkPinMapping(metadata: SessionInfo['metadata'], sourceSessionID: string, source: readonly ForkMessage[], copied: readonly ForkMessage[]) {
  const parsed = PinsMetadataSchema.safeParse(metadata);
  const mapping = new Map<string, string | null>();
  if (!parsed.success) return mapping;
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
  for (const value of parsed.data.openchamber.context_obligatory_messages) {
    const pin = PinSchema.safeParse(value);
    if (!pin.success || (pin.data.sessionID && pin.data.sessionID !== sourceSessionID)) continue;
    const original = source.find((message) => message.id === pin.data.id);
    if (!original) continue;
    const matches = originals.get(messageKey(original));
    const targets = copies.get(messageKey(original)) ?? [];
    if (matches?.length !== 1 || matches[0]?.id !== pin.data.id || targets.length > 1) continue;
    mapping.set(pin.data.id, targets[0]?.id ?? null);
  }
  return mapping;
}

const hasInheritedPin = (metadata: SessionInfo['metadata'], sourceSessionID: string) => {
  const parsed = PinsMetadataSchema.safeParse(metadata);
  return parsed.success && parsed.data.openchamber.context_obligatory_messages.some((value) => {
    const pin = PinSchema.safeParse(value);
    return pin.success && (!pin.data.sessionID || pin.data.sessionID === sourceSessionID);
  });
};

function pinPatch(mapping: Map<string, string | null>, forkID: string): MetadataDecider {
  return (metadata) => {
    const parsed = PinsMetadataSchema.safeParse(metadata);
    if (!parsed.success) return null;
    const current = parsed.data.openchamber.context_obligatory_messages;
    const pinned = new Set(current.flatMap((value) => {
      const pin = PinSchema.safeParse(value);
      return pin.success ? [pin.data.id] : [];
    }));
    let changed = false;
    const pins = current.flatMap((value) => {
      const pin = PinSchema.safeParse(value);
      if (!pin.success || !mapping.has(pin.data.id)) return [value];
      changed = true;
      const id = mapping.get(pin.data.id);
      return id && !pinned.has(id) ? [{ ...pin.data, id, sessionID: forkID }] : [];
    });
    return changed ? { openchamber: { context_obligatory_messages: pins } } : null;
  };
}

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
  for (const key of ['btwSessionID', 'reviewSessionID', 'lead']) {
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
  readMessages: (sessionID: string) => Promise<readonly ForkMessage[]>;
  updatePins: (sessionID: string, decide: MetadataDecider) => Promise<void>;
}

export const applyForkInheritance = async <ObjectiveResult, MetadataResult, PermissionsResult>({ sourceSessionID, fork, readObjective, writeObjective, writeMetadata, writePermissions = null, readMessages, updatePins }: ForkInheritanceOptions<ObjectiveResult, MetadataResult, PermissionsResult>) => {
  const metadata = fork?.metadata;
  if (hasInheritedPin(metadata, sourceSessionID)) {
    try {
      const [source, copied] = await Promise.all([readMessages(sourceSessionID), readMessages(fork.id)]);
      const mapping = forkPinMapping(metadata, sourceSessionID, source, copied);
      if (mapping.size) await updatePins(fork.id, pinPatch(mapping, fork.id));
    } catch (error) {
      console.warn('[fork] failed to repair inherited pins', (hasMessage(error) ? error.message : undefined) ?? error);
    }
  }
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
