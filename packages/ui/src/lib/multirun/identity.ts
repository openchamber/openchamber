import { z } from 'zod';
import { parseMetadata } from '@/lib/metadataParse';
import type { JsonValue, Metadata, Session } from '@/lib/opencode/model';
import { normalizePath } from '@/lib/pathNormalization';
import { parseMultiRunSessionTitle } from './title';

const identifier = z.string().min(1).refine((value) => value === value.trim());
const groupSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('id'), id: z.uuid() }),
  z.object({ kind: z.literal('legacy'), scope: identifier }),
]);
const autoFusionSchema = z.object({
  providerID: identifier,
  modelID: identifier,
  variant: identifier.optional(),
  agent: identifier.optional(),
  launcherId: identifier,
});
const membershipSchema = z.object({
  version: z.literal(1),
  sessionID: identifier.nullable(),
  group: groupSchema,
  groupSlug: identifier,
  runGroup: z.string().regex(/^g[1-9]\d*$/).optional(),
  providerID: identifier,
  modelID: identifier,
  index: z.number().int().positive().safe().optional(),
  role: z.enum(['run', 'fusion']),
  title: z.string().trim().min(1).max(200).optional(),
  autoFusion: autoFusionSchema.optional(),
}).refine((value) => value.group.kind !== 'legacy' || value.role === 'fusion');
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);
const openchamberSchema: z.ZodType<Metadata> = z.record(z.string(), jsonValueSchema);
const membershipEnvelopeSchema = z.object({ multirun: membershipSchema });

export type MultiRunMembership = z.infer<typeof membershipSchema>;
export type MultiRunIdentity = Omit<MultiRunMembership, 'version' | 'sessionID'> & { key: string };

export const multiRunGroupKey = (group: MultiRunMembership['group'], groupSlug: string): string =>
  group.kind === 'id' ? JSON.stringify(['id', group.id]) : JSON.stringify(['legacy', group.scope, groupSlug]);

export function getMultiRunMembership(session: Session): MultiRunMembership | null {
  const envelope = parseMetadata(membershipEnvelopeSchema, session.metadata?.openchamber);
  return envelope.success && envelope.data.multirun.sessionID === session.id ? envelope.data.multirun : null;
}

export function getMultiRunIdentity(session: Session, legacyDirectory = session.directory): MultiRunIdentity | null {
  return resolveMultiRunIdentity(session, () => legacyDirectory);
}

export function resolveMultiRunIdentity(
  session: Session,
  readLegacyDirectory: () => string | null | undefined,
): MultiRunIdentity | null {
  const parsedOpenchamber = parseMetadata(openchamberSchema, session.metadata?.openchamber);
  const openchamber = parsedOpenchamber.success ? parsedOpenchamber.data : null;
  if (openchamber && Object.hasOwn(openchamber, 'multirun')) {
    const membership = getMultiRunMembership(session);
    if (!membership) return null;
    const { group, groupSlug, runGroup, providerID, modelID, index, role, title, autoFusion } = membership;
    return {
      group, groupSlug, runGroup, providerID, modelID, index, role, title, autoFusion,
      key: multiRunGroupKey(group, groupSlug),
    };
  }
  if (session.parentID || openchamber?.kind === 'btw' || openchamber?.kind === 'review') return null;
  const title = parseMultiRunSessionTitle(session.title);
  if (!title) return null;
  const scope = normalizePath(readLegacyDirectory());
  if (!scope) return null;
  const group: MultiRunMembership['group'] = { kind: 'legacy', scope };
  return {
    group, groupSlug: title.groupSlug, runGroup: title.runGroup,
    providerID: title.providerID, modelID: title.modelID, index: title.index,
    role: title.fusion ? 'fusion' : 'run',
    key: multiRunGroupKey(group, title.groupSlug),
  };
}

const membershipMetadata = (membership: MultiRunMembership): Metadata => {
  const value = membershipSchema.parse(membership);
  const marker: Metadata = {
    version: value.version,
    sessionID: value.sessionID,
    group: value.group.kind === 'id'
      ? { kind: value.group.kind, id: value.group.id }
      : { kind: value.group.kind, scope: value.group.scope },
    groupSlug: value.groupSlug,
    providerID: value.providerID,
    modelID: value.modelID,
    role: value.role,
  };
  if (value.runGroup !== undefined) marker.runGroup = value.runGroup;
  if (value.index !== undefined) marker.index = value.index;
  if (value.title !== undefined) marker.title = value.title;
  if (value.autoFusion !== undefined) {
    const { providerID, modelID, variant, agent, launcherId } = value.autoFusion;
    const autoFusion: Metadata = { providerID, modelID, launcherId };
    if (variant !== undefined) autoFusion.variant = variant;
    if (agent !== undefined) autoFusion.agent = agent;
    marker.autoFusion = autoFusion;
  }
  return marker;
};

export function withMultiRunMembership(session: Pick<Session, 'metadata'>, membership: MultiRunMembership): Metadata {
  const parsed = openchamberSchema.safeParse(session.metadata?.openchamber);
  const openchamber = parsed.success ? parsed.data : {};
  return {
    ...session.metadata,
    openchamber: { ...openchamber, multirun: membershipMetadata(membership) },
  };
}

export const multiRunMembershipPatch = (membership: MultiRunMembership): Metadata => ({
  openchamber: { multirun: membershipMetadata(membership) },
});

export function sameMultiRunIdentity(a: Session, b: Session): boolean {
  if (a.id === b.id && a.metadata === b.metadata && a.title === b.title && a.directory === b.directory && a.parentID === b.parentID) return true;
  const left = getMultiRunIdentity(a);
  const right = getMultiRunIdentity(b);
  if (!left || !right) return left === right;
  return left.key === right.key && left.runGroup === right.runGroup && left.role === right.role
    && left.groupSlug === right.groupSlug && left.providerID === right.providerID
    && left.modelID === right.modelID && left.index === right.index && left.title === right.title;
}
