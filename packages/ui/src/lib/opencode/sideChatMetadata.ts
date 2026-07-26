import type { Session } from '@opencode-ai/sdk/v2';

type SideChatMetadataRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const getMetadata = (session: Session | null | undefined): SideChatMetadataRecord => {
  const metadata = (session as (Session & { metadata?: unknown }) | null | undefined)?.metadata;
  return isRecord(metadata) ? metadata : {};
};

const getOpenChamberMetadata = (metadata: SideChatMetadataRecord): SideChatMetadataRecord =>
  isRecord(metadata.openchamber) ? metadata.openchamber : {};

const getSideChatMetadata = (metadata: SideChatMetadataRecord): SideChatMetadataRecord => {
  const sideChat = getOpenChamberMetadata(metadata).sideChat;
  return isRecord(sideChat) ? sideChat : {};
};

export const getDisposableSideChatParentID = (session: Session | null | undefined): string | null => {
  const sideChat = getSideChatMetadata(getMetadata(session));
  const parentSessionID = sideChat.parentSessionID;
  return sideChat.disposable === true && typeof parentSessionID === 'string' && parentSessionID.trim()
    ? parentSessionID
    : null;
};

export const isDisposableSideChat = (session: Session | null | undefined): boolean =>
  getDisposableSideChatParentID(session) !== null;
