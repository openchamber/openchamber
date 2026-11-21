import { z } from 'zod';
import { parseMetadata } from '@/lib/metadataParse';
import type { Session } from '@/lib/opencode/model';
import type { GlobalSessionStructure } from '@/stores/globalSessionStructure';
import { isDoneSuggested, isReviewSuggested } from '@/lib/sessionWorkMetadata';

const ROW_ONLY_FIELDS: ReadonlySet<string> = new Set(['tokens', 'cost', 'outcome', 'model', 'agent']);

const openchamberSchema = z.object({ openchamber: z.record(z.string(), z.json()) });

const structuralMetadata = (metadata: Session['metadata']): Session['metadata'] => {
  if (!metadata) return undefined;
  const openchamber = parseMetadata(openchamberSchema, metadata).data?.openchamber;
  const next: NonNullable<Session['metadata']> = {};
  for (const [field, value] of Object.entries(metadata)) {
    if (field !== 'openchamber' || !openchamber) {
      next[field] = value;
      continue;
    }
    const { turn: _turn, ...rest } = openchamber;
    if (Object.keys(rest).length > 0) next.openchamber = rest;
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

const buildKey = (session: Session, withActivityTime: boolean): string => {
  const projected: Record<string, Session[keyof Session] | boolean> = {};
  for (const [field, value] of Object.entries(session)) {
    if (ROW_ONLY_FIELDS.has(field)) continue;
    if (field === 'time') {
      const { idle: _idle, updated, ...time } = session.time ?? {};
      projected.time = withActivityTime ? { ...time, updated } : time;
    } else if (field === 'metadata') {
      projected.metadata = structuralMetadata(session.metadata);
    } else {
      projected[field] = value;
    }
  }
  projected.doneSuggested = isDoneSuggested(session);
  projected.reviewSuggested = isReviewSuggested(session);
  return JSON.stringify(projected);
};

const keysBySession = new WeakMap<Session, { plain?: string; withActivityTime?: string }>();

const sidebarStructureKey = (session: Session, withActivityTime: boolean): string => {
  let keys = keysBySession.get(session);
  if (!keys) {
    keys = {};
    keysBySession.set(session, keys);
  }
  if (withActivityTime) {
    keys.withActivityTime ??= buildKey(session, true);
    return keys.withActivityTime;
  }
  keys.plain ??= buildKey(session, false);
  return keys.plain;
};

export const haveSameSidebarStructure = (
  previous: readonly Session[],
  next: readonly Session[],
  withActivityTime: boolean,
): boolean => {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index];
    const after = next[index];
    if (before === after) continue;
    if (!before || !after || before.id !== after.id) return false;
    if (sidebarStructureKey(before, withActivityTime) !== sidebarStructureKey(after, withActivityTime)) return false;
  }
  return true;
};

const sameIds = (left: readonly string[], right: readonly string[]): boolean => (
  left === right || (left.length === right.length && left.every((id, index) => id === right[index]))
);

export const haveSameSidebarHierarchy = (previous: GlobalSessionStructure, next: GlobalSessionStructure): boolean => {
  if (!sameIds(previous.activeRootIds, next.activeRootIds)) return false;
  const before = previous.activeChildrenByParentId;
  const after = next.activeChildrenByParentId;
  if (before === after) return true;
  if (before.size !== after.size) return false;
  for (const [parentId, childIds] of after) {
    const previousChildIds = before.get(parentId);
    if (!previousChildIds || !sameIds(previousChildIds, childIds)) return false;
  }
  return true;
};
