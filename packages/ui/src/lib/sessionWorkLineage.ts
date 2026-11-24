import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';
import { isVSCodeRuntime } from '@/lib/desktop';
import { parseMetadata } from '@/lib/metadataParse';
import { normalizePath } from '@/lib/pathNormalization';
import { getBtwOriginalSessionID, isBtwSession, wasPromotedBtwSession } from '@/lib/sessionBtwMetadata';
import { getOriginalSessionID, isReviewSession } from '@/lib/sessionReviewMetadata';


const openchamberNamespaceSchema = z.object({ openchamber: z.record(z.string(), z.json()) });

const getSessionOriginId = (session: Session): string | null => {
  if (isReviewSession(session)) return getOriginalSessionID(session);
  if (isBtwSession(session) || wasPromotedBtwSession(session)) {
    return getBtwOriginalSessionID(session) ?? (session.fork?.sessionID?.trim() || null);
  }
  return null;
};

const isMultiRunLane = (session: Session): boolean => Object.hasOwn(
  parseMetadata(openchamberNamespaceSchema, session.metadata).data?.openchamber ?? {},
  'multirun',
);

const sameFolder = (left: Session, right: Session): boolean => {
  const leftDirectory = normalizePath(left.directory ?? null);
  return leftDirectory !== null && leftDirectory === normalizePath(right.directory ?? null);
};

export const isSubagentSession = (session: Session): boolean => Boolean(
  session.parentID && !isReviewSession(session) && !isBtwSession(session) && !wasPromotedBtwSession(session),
);

export const resolveSessionNestingParentId = (
  session: Session,
  lookup: (sessionId: string) => Session | undefined,
): string | null => {
  if (session.parentID) return session.parentID;
  if (isVSCodeRuntime() || session.time?.archived || isMultiRunLane(session)) return null;
  const originId = getSessionOriginId(session);
  if (!originId || originId === session.id) return null;
  const origin = lookup(originId);
  if (!origin || origin.time?.archived || !sameFolder(session, origin)) return null;
  const seen = new Set<string>([session.id]);
  let current: Session | undefined = origin;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const next = current.parentID ?? getSessionOriginId(current);
    if (!next) return originId;
    if (seen.has(next)) return next === session.id ? null : originId;
    current = lookup(next);
  }
  return originId;
};
