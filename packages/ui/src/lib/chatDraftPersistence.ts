import { normalizePath } from '@/lib/pathNormalization';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { countSyncPersistenceSerialization } from '@/sync/performance-diagnostics';

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
let cachedRawEnvelope: string | null | undefined;
let cachedEnvelope: PersistedChatDraftEnvelope | undefined;

export const createChatDraftIdentity = (
  runtimeKey: string,
  directory: string | null | undefined,
  sessionId: string | null,
): ChatDraftIdentity | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!runtimeKey || !normalizedDirectory) return null;
  return { runtimeKey, directory: normalizedDirectory, sessionId };
};

const WORK_DRAFT_KEY_PREFIX = 'draft:';

/**
 * The composer key of a new session's draft. Each draft opened in a project
 * has its own, so two drafts in one folder never share their text; the draft
 * becomes a session under its own id when sent. A new Chat, and every draft in
 * VS Code, keep the per-folder key `null`.
 */
export const workDraftComposerKey = (workDraftId: string): string => `${WORK_DRAFT_KEY_PREFIX}${workDraftId}`;

/** The draft id of a project draft's composer key, or null for any other key. */
export const workDraftIdOfComposerKey = (sessionId: string | null | undefined): string | null => (
  sessionId?.startsWith(WORK_DRAFT_KEY_PREFIX) ? sessionId.slice(WORK_DRAFT_KEY_PREFIX.length) : null
);

/** Whether the identity is a new session's draft rather than a session's composer. */
export const isNewSessionDraftIdentity = (identity: ChatDraftIdentity): boolean => (
  identity.sessionId === null || workDraftIdOfComposerKey(identity.sessionId) !== null
);

export const getChatDraftIdentityKey = (identity: ChatDraftIdentity): string =>
  JSON.stringify([identity.runtimeKey, identity.directory, identity.sessionId]);

const readEnvelope = (): PersistedChatDraftEnvelope => {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === cachedRawEnvelope && cachedEnvelope) return cachedEnvelope;
  try {
    const parsed = JSON.parse(raw ?? '') as Partial<PersistedChatDraftEnvelope>;
    if (parsed.version !== 2 || !parsed.drafts || typeof parsed.drafts !== 'object' || Array.isArray(parsed.drafts)) {
      cachedRawEnvelope = raw;
      cachedEnvelope = { version: 2, drafts: {} };
      return cachedEnvelope;
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
    cachedRawEnvelope = raw;
    cachedEnvelope = { version: 2, drafts };
    return cachedEnvelope;
  } catch {
    storage.removeItem(STORAGE_KEY);
    cachedRawEnvelope = null;
    cachedEnvelope = { version: 2, drafts: {} };
    return cachedEnvelope;
  }
};

const writeEnvelope = (envelope: PersistedChatDraftEnvelope): void => {
  const serialized = JSON.stringify(envelope);
  cachedRawEnvelope = serialized;
  cachedEnvelope = envelope;
  countSyncPersistenceSerialization(serialized);
  storage.setItem(STORAGE_KEY, serialized);
};

export const readChatDraft = (identity: ChatDraftIdentity | null): ChatDraftSnapshot => {
  if (!identity) return { text: '', confirmedMentions: new Set() };
  const persisted = readEnvelope().drafts[getChatDraftIdentityKey(identity)];
  return persisted
    ? { text: persisted.text, confirmedMentions: new Set(persisted.confirmedMentions) }
    : { text: '', confirmedMentions: new Set() };
};

/**
 * `readChatDraft` for a composer opening an identity. A project draft opened
 * under its own key (`draft:<id>`) with nothing saved there takes over the
 * text its folder kept under the per-folder key, where every new project
 * draft was saved before drafts had their own; the folder key is emptied, so
 * only one draft takes it.
 */
export const readChatDraftClaimingFolderDraft = (identity: ChatDraftIdentity | null): ChatDraftSnapshot => {
  const saved = readChatDraft(identity);
  if (!identity || workDraftIdOfComposerKey(identity.sessionId) === null || saved.text) return saved;
  const folderIdentity = { ...identity, sessionId: null };
  const folderDraft = readChatDraft(folderIdentity);
  if (!folderDraft.text) return saved;
  writeChatDraft(identity, folderDraft.text, folderDraft.confirmedMentions);
  clearChatDraft(folderIdentity);
  return folderDraft;
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
