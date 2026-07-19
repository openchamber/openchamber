import { normalizePath } from '@/lib/pathNormalization';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';

export type ChatDraftIdentity = {
  runtimeKey: string;
  directory: string;
  sessionId: string | null;
};

export type ChatDraftSnapshot = {
  text: string;
  confirmedMentions: Set<string>;
};

type PersistedChatDraft = {
  text: string;
  confirmedMentions: string[];
  touchedAt: number;
};

type PersistedChatDraftEnvelope = {
  version: 2;
  drafts: Record<string, PersistedChatDraft>;
};

const STORAGE_KEY = 'openchamber.chatDrafts.v2';
const MAX_DRAFTS = 50;
const storage = getDeferredSafeStorage();
const deletionListeners = new Set<(identity: ChatDraftIdentity) => void>();

export const createChatDraftIdentity = (
  runtimeKey: string,
  directory: string | null | undefined,
  sessionId: string | null,
): ChatDraftIdentity | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!runtimeKey || !normalizedDirectory) return null;
  return { runtimeKey, directory: normalizedDirectory, sessionId };
};

export const getChatDraftIdentityKey = (identity: ChatDraftIdentity): string =>
  JSON.stringify([identity.runtimeKey, identity.directory, identity.sessionId]);

const readEnvelope = (): PersistedChatDraftEnvelope => {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '') as Partial<PersistedChatDraftEnvelope>;
    if (parsed.version !== 2 || !parsed.drafts || typeof parsed.drafts !== 'object' || Array.isArray(parsed.drafts)) {
      return { version: 2, drafts: {} };
    }
    const drafts: Record<string, PersistedChatDraft> = {};
    for (const [key, value] of Object.entries(parsed.drafts)) {
      if (!value || typeof value !== 'object') continue;
      const draft = value as Partial<PersistedChatDraft>;
      if (typeof draft.text !== 'string' || !Array.isArray(draft.confirmedMentions) || typeof draft.touchedAt !== 'number') continue;
      drafts[key] = {
        text: draft.text,
        confirmedMentions: draft.confirmedMentions.filter((mention): mention is string => typeof mention === 'string'),
        touchedAt: draft.touchedAt,
      };
    }
    return { version: 2, drafts };
  } catch {
    storage.removeItem(STORAGE_KEY);
    return { version: 2, drafts: {} };
  }
};

const writeEnvelope = (envelope: PersistedChatDraftEnvelope): void => {
  storage.setItem(STORAGE_KEY, JSON.stringify(envelope));
};

export const readChatDraft = (identity: ChatDraftIdentity | null): ChatDraftSnapshot => {
  if (!identity) return { text: '', confirmedMentions: new Set() };
  const persisted = readEnvelope().drafts[getChatDraftIdentityKey(identity)];
  return persisted
    ? { text: persisted.text, confirmedMentions: new Set(persisted.confirmedMentions) }
    : { text: '', confirmedMentions: new Set() };
};

export const writeChatDraft = (
  identity: ChatDraftIdentity | null,
  text: string,
  confirmedMentions: Iterable<string>,
): void => {
  if (!identity) return;
  const envelope = readEnvelope();
  const key = getChatDraftIdentityKey(identity);
  const mentions = Array.from(new Set(confirmedMentions));
  if (!text && mentions.length === 0) {
    if (!(key in envelope.drafts)) return;
    delete envelope.drafts[key];
  } else {
    envelope.drafts[key] = { text, confirmedMentions: mentions, touchedAt: Date.now() };
  }

  const retained = Object.entries(envelope.drafts)
    .sort((left, right) => right[1].touchedAt - left[1].touchedAt)
    .slice(0, MAX_DRAFTS);
  writeEnvelope({ version: 2, drafts: Object.fromEntries(retained) });
};

export const clearChatDraft = (identity: ChatDraftIdentity, notify = false): void => {
  writeChatDraft(identity, '', []);
  if (notify) deletionListeners.forEach((listener) => listener(identity));
};

export const subscribeChatDraftDeletion = (listener: (identity: ChatDraftIdentity) => void): (() => void) => {
  deletionListeners.add(listener);
  return () => deletionListeners.delete(listener);
};
