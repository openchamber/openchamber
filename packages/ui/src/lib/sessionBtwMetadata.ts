import type { Session } from '@/lib/opencode/model';
import { getSessionMetadata, type SessionMetadataRecord } from '@/lib/sessionReviewMetadata';

type BtwMetadata = {
  kind?: string;
  originalSessionID?: string;
  btwSessionID?: string;
  btwBoundaryMessageID?: string;
  btwPromoted?: boolean;
};

const getOpenChamberMetadata = (metadata: SessionMetadataRecord): BtwMetadata => {
  const value = metadata.openchamber;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  // SAFETY: session metadata is persisted, externally writable data; this is
  // its parsing boundary. `BtwMetadata` only declares optional fields and
  // every reader re-validates the field it consumes in `nonEmpty`.
  return value as BtwMetadata;
};

const nonEmpty = (value: string | undefined): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

export const getBtwSessionID = (session: Session | null | undefined): string | null =>
  nonEmpty(getOpenChamberMetadata(getSessionMetadata(session)).btwSessionID);

export const wasPromotedBtwSession = (session: Session | null | undefined): boolean =>
  getOpenChamberMetadata(getSessionMetadata(session)).btwPromoted === true;

export const isBtwSession = (session: Session | null | undefined): boolean =>
  getOpenChamberMetadata(getSessionMetadata(session)).kind === 'btw'
  && Boolean(getBtwOriginalSessionID(session));

export const getBtwOriginalSessionID = (session: Session | null | undefined): string | null => {
  const openchamber = getOpenChamberMetadata(getSessionMetadata(session));
  return openchamber.kind === 'btw' ? nonEmpty(openchamber.originalSessionID) : null;
};

export const getBtwBoundaryMessageID = (session: Session | null | undefined): string | null => {
  const openchamber = getOpenChamberMetadata(getSessionMetadata(session));
  return openchamber.kind === 'btw' ? nonEmpty(openchamber.btwBoundaryMessageID) : null;
};

export const withBtwSessionLink = (
  metadata: SessionMetadataRecord,
  btwSessionID: string,
): SessionMetadataRecord => ({
  ...metadata,
  openchamber: {
    ...getOpenChamberMetadata(metadata),
    btwSessionID,
  },
});

export const withBtwSessionMarker = (
  metadata: SessionMetadataRecord,
  originalSessionID: string,
  boundaryMessageID: string | null,
): SessionMetadataRecord => {
  const openchamber: BtwMetadata = { kind: 'btw', originalSessionID };
  if (boundaryMessageID) openchamber.btwBoundaryMessageID = boundaryMessageID;
  return { ...metadata, openchamber };
};

export const withoutBtwSessionMarker = (metadata: SessionMetadataRecord): SessionMetadataRecord => {
  const openchamber = getOpenChamberMetadata(metadata);
  if (openchamber.kind !== 'btw') return metadata;
  const rest: BtwMetadata = { ...openchamber };
  delete rest.kind;
  delete rest.originalSessionID;
  delete rest.btwBoundaryMessageID;
  rest.btwPromoted = true;
  return { ...metadata, openchamber: rest };
};

export const withoutBtwSessionLink = (
  metadata: SessionMetadataRecord,
  btwSessionID: string,
): SessionMetadataRecord => {
  const openchamber = getOpenChamberMetadata(metadata);
  if (openchamber.btwSessionID !== btwSessionID) return metadata;
  const rest: BtwMetadata = { ...openchamber };
  delete rest.btwSessionID;
  const next: SessionMetadataRecord = { ...metadata };
  if (Object.keys(rest).length > 0) {
    next.openchamber = rest;
  } else {
    delete next.openchamber;
  }
  return next;
};
