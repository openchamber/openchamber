import { z } from 'zod';

import {
  createChatDraftIdentity,
  getChatDraftIdentityKey,
  isNewSessionDraftIdentity,
  workDraftIdOfComposerKey,
  type ChatDraftIdentity,
} from '@/lib/chatDraftPersistence';
import { rememberDraftAttachmentNames } from '@/lib/draftAttachmentNames';
import { withoutShareLinkKeys } from '@/lib/received-pages/link';
import { flushDeferredStorage, getSafeSessionStorage, getSafeStorage, listStorageKeys } from '@/stores/utils/safeStorage';

export const UNCONFIRMED_SEND_KEY_PREFIX = 'openchamber.unconfirmedSend.v1.';
const PAGE_LOCK_PREFIX = 'openchamber.page.';
const RECOVERY_LOCK = 'openchamber.unconfirmedSends.recovery';

const recordSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  identity: z.object({ runtimeKey: z.string(), directory: z.string(), sessionId: z.string().nullable() }),
  text: z.string(),
  confirmedMentions: z.array(z.string()),
  attachmentNames: z.array(z.string()),
  sessionId: z.string().nullable(),
  messageId: z.string().nullable(),
  left: z.boolean(),
});

export type UnconfirmedSend = z.infer<typeof recordSchema>;

type UnconfirmedSendComposer = {
  shown: () => ChatDraftIdentity | null;
  restore: (target: ChatDraftIdentity, text: string, confirmedMentions: Set<string>) => void;
  discardDraft: (workDraftId: string) => void;
};

export type UnconfirmedSendServer = {
  isCurrent: () => boolean;
  ready: () => Promise<void>;
  sessionDirectory: (sessionId: string) => Promise<string | null>;
  hasMessage: (sessionId: string, messageId: string, directory: string) => Promise<boolean>;
};

const webLocks = (): LockManager | null => globalThis.navigator?.locks ?? null;
const sharedAcrossPages = webLocks() !== null;
const storage = sharedAcrossPages ? getSafeStorage() : getSafeSessionStorage();
const randomPart = () => Math.random().toString(36).slice(2);
const pageId = `${Date.now().toString(36)}-${randomPart()}`;
const recoveredRuntimes = new Set<string>();
let pageLockRequested = false;

const keyOf = (id: string) => `${UNCONFIRMED_SEND_KEY_PREFIX}${id}`;

const removeAfterRestoredDraft = (id: string): void => {
  flushDeferredStorage();
  storage.removeItem(keyOf(id));
};

const readRecord = (key: string): UnconfirmedSend | null => {
  try {
    const record = recordSchema.safeParse(JSON.parse(storage.getItem(key) ?? 'null'));
    return record.success ? record.data : null;
  } catch {
    return null;
  }
};

const readRecords = (): UnconfirmedSend[] => listStorageKeys(storage)
  .filter((key) => key.startsWith(UNCONFIRMED_SEND_KEY_PREFIX))
  .flatMap((key) => readRecord(key) ?? []);

const updateRecord = (id: string, change: (record: UnconfirmedSend) => UnconfirmedSend): void => {
  const record = readRecord(keyOf(id));
  if (record) storage.setItem(keyOf(id), JSON.stringify(change(record)));
};

export const holdPageLock = (): void => {
  const locks = webLocks();
  if (!locks || pageLockRequested) return;
  pageLockRequested = true;
  void locks.request(`${PAGE_LOCK_PREFIX}${pageId}`, () => new Promise<never>(() => undefined));
};

const livePages = async (): Promise<Set<string>> => {
  const locks = webLocks();
  if (!locks) return new Set();
  const state = await locks.query();
  return new Set((state.held ?? []).flatMap((lock) => (
    lock.name?.startsWith(PAGE_LOCK_PREFIX) ? [lock.name.slice(PAGE_LOCK_PREFIX.length)] : []
  )));
};

export const trackUnconfirmedSend = (input: {
  identity: ChatDraftIdentity;
  text: string;
  confirmedMentions: Iterable<string>;
  attachmentNames: readonly string[];
}) => {
  const id = `${pageId}-${randomPart()}`;
  const record: UnconfirmedSend = {
    id,
    pageId,
    identity: input.identity,
    text: withoutShareLinkKeys(input.text),
    confirmedMentions: [...input.confirmedMentions],
    attachmentNames: [...input.attachmentNames],
    sessionId: isNewSessionDraftIdentity(input.identity) ? null : input.identity.sessionId,
    messageId: null,
    left: false,
  };
  storage.setItem(keyOf(id), JSON.stringify(record));
  return {
    progress: {
      sessionMinted: (sessionId: string) => updateRecord(id, (current) => ({ ...current, sessionId })),
      messageMinted: (messageId: string) => updateRecord(id, (current) => ({ ...current, messageId })),
      requestLeaving: () => updateRecord(id, (current) => ({ ...current, left: true })),
    },
    settle: () => removeAfterRestoredDraft(id),
  };
};

type Outcome = { kind: 'restore'; target: ChatDraftIdentity } | { kind: 'drop' } | { kind: 'unknown' };

const needsServer = (record: UnconfirmedSend) => record.left || (record.sessionId !== null && isNewSessionDraftIdentity(record.identity));

const decide = async (record: UnconfirmedSend, server: UnconfirmedSendServer): Promise<Outcome> => {
  let target: ChatDraftIdentity = record.identity;
  if (record.sessionId && isNewSessionDraftIdentity(record.identity)) {
    const directory = await server.sessionDirectory(record.sessionId);
    if (directory) target = createChatDraftIdentity(record.identity.runtimeKey, directory, record.sessionId) ?? target;
  }
  if (!record.left) return { kind: 'restore', target };
  if (!record.sessionId || !record.messageId) return { kind: 'drop' };
  return await server.hasMessage(record.sessionId, record.messageId, target.directory)
    ? { kind: 'drop' }
    : { kind: 'restore', target };
};

export const draftRestoreTarget = (target: ChatDraftIdentity, shown: ChatDraftIdentity | null): ChatDraftIdentity => {
  if (workDraftIdOfComposerKey(target.sessionId) === null) return target;
  const shownIsDraftOfFolder = shown !== null
    && isNewSessionDraftIdentity(shown)
    && shown.runtimeKey === target.runtimeKey
    && shown.directory === target.directory;
  return shownIsDraftOfFolder ? shown : { ...target, sessionId: null };
};

const restoreRecord = (record: UnconfirmedSend, target: ChatDraftIdentity, composer: UnconfirmedSendComposer): void => {
  const shownTarget = draftRestoreTarget(target, composer.shown());
  const leftDraftId = workDraftIdOfComposerKey(target.sessionId);
  if (leftDraftId && getChatDraftIdentityKey(shownTarget) !== getChatDraftIdentityKey(target)) composer.discardDraft(leftDraftId);
  rememberDraftAttachmentNames(shownTarget, record.attachmentNames);
  composer.restore(shownTarget, record.text, new Set(record.confirmedMentions));
};

const recover = async (runtimeKey: string, composer: UnconfirmedSendComposer, server: UnconfirmedSendServer): Promise<void> => {
  const live = await livePages();
  const interrupted = readRecords().filter((record) => (
    record.identity.runtimeKey === runtimeKey && record.pageId !== pageId && !live.has(record.pageId)
  ));
  if (interrupted.length === 0) return;
  if (interrupted.some(needsServer)) {
    try {
      await server.ready();
    } catch {
      return;
    }
  }
  for (const record of interrupted) {
    const outcome: Outcome = needsServer(record)
      ? await decide(record, server).catch(() => ({ kind: 'unknown' as const }))
      : { kind: 'restore', target: record.identity };
    if (!server.isCurrent()) return;
    if (outcome.kind === 'unknown') continue;
    if (outcome.kind === 'restore') restoreRecord(record, outcome.target, composer);
    removeAfterRestoredDraft(record.id);
  }
};

export const recoverUnconfirmedSends = async (
  runtimeKey: string,
  composer: UnconfirmedSendComposer,
  server: UnconfirmedSendServer,
): Promise<void> => {
  if (recoveredRuntimes.has(runtimeKey)) return;
  recoveredRuntimes.add(runtimeKey);
  const locks = webLocks();
  if (!locks) return recover(runtimeKey, composer, server);
  await locks.request(RECOVERY_LOCK, () => recover(runtimeKey, composer, server));
};
