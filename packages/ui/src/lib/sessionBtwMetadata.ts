import type { Session } from '@/lib/opencode/model';
import { getSessionMetadata, type SessionMetadataRecord } from '@/lib/sessionReviewMetadata';

/**
 * Compatibility for `/btw` forks created before the stateless side question.
 * New `/btw` requests never write this metadata; the readers keep old forks
 * out of the sidebar and old promoted sessions in their display lineage. The
 * one writer unlinks a parent when an old fork is deleted.
 */
type LegacyBtwMetadata = {
  kind?: string;
  originalSessionID?: string;
  btwSessionID?: string;
  btwPromoted?: boolean;
};

const getOpenChamberMetadata = (metadata: SessionMetadataRecord): LegacyBtwMetadata => {
  const value = metadata.openchamber;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  // SAFETY: session metadata is persisted, externally writable data; this is
  // its parsing boundary. Every reader re-validates the field it consumes.
  return value as LegacyBtwMetadata;
};

const nonEmpty = (value: string | undefined): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

/** The parent's link to a legacy btw fork, kept so retention and deletion can clean it up. */
export const getBtwSessionID = (session: Session | null | undefined): string | null =>
  nonEmpty(getOpenChamberMetadata(getSessionMetadata(session)).btwSessionID);

/** Removes a legacy parent link when its old fork is deleted. */
export const withoutBtwSessionLink = (
  metadata: SessionMetadataRecord,
  btwSessionID: string,
): SessionMetadataRecord => {
  const openchamber = getOpenChamberMetadata(metadata);
  if (openchamber.btwSessionID !== btwSessionID) return metadata;
  const rest: LegacyBtwMetadata = { ...openchamber };
  delete rest.btwSessionID;
  const next: SessionMetadataRecord = { ...metadata };
  if (Object.keys(rest).length > 0) {
    next.openchamber = rest;
  } else {
    delete next.openchamber;
  }
  return next;
};

/** The session is a legacy `/btw` fork and stays hidden from sidebar lists. */
export const isBtwSession = (session: Session | null | undefined): boolean =>
  getOpenChamberMetadata(getSessionMetadata(session)).kind === 'btw'
  && Boolean(getBtwOriginalSessionID(session));

/** The session was once a legacy `/btw` fork and was promoted to a normal session. */
export const wasPromotedBtwSession = (session: Session | null | undefined): boolean =>
  getOpenChamberMetadata(getSessionMetadata(session)).btwPromoted === true;

/** The legacy fork's back-pointer to the session `/btw` was typed into. */
export const getBtwOriginalSessionID = (session: Session | null | undefined): string | null => {
  const openchamber = getOpenChamberMetadata(getSessionMetadata(session));
  return openchamber.kind === 'btw' ? nonEmpty(openchamber.originalSessionID) : null;
};
