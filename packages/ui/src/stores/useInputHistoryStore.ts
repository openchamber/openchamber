import { create } from 'zustand';
import { z } from 'zod';

import {
  DEFAULT_INPUT_HISTORY_LIMIT,
  DEFAULT_INPUT_HISTORY_SCOPE,
  isInputHistoryLimit,
  isInputHistoryScope,
  type InputHistoryScope,
} from '@/lib/inputHistoryScope';
import { normalizePath } from '@/lib/pathNormalization';
import type { AttachedFile } from '@/stores/types/sessionTypes';

export type InputHistoryIdentity = {
  runtimeKey: string;
  directory: string;
  sessionId: string;
};

export type InputHistoryAttachment = {
  key: string;
  source: 'file-url' | 'vscode-file';
  filename: string;
  mimeType: string;
  size: number;
  reference: string;
};

export type InputHistorySubmission = {
  text: string;
  attachmentKeys: string[];
  restorableAttachments: InputHistoryAttachment[];
};

export type InputHistoryEntry = InputHistorySubmission & {
  submittedAt: number;
};

type InputHistoryNamespace = {
  touchedAt: number;
  entries: InputHistoryEntry[];
};

type InputHistorySnapshot = {
  entryLimit: number;
  scope: InputHistoryScope;
  globalBuckets: Record<string, InputHistoryNamespace>;
  sessionBuckets: Record<string, InputHistoryNamespace>;
};

type PersistedInputHistoryEnvelope = {
  version: 1;
  entryLimit?: number;
  scope: InputHistoryScope;
  global: Record<string, InputHistoryNamespace>;
  session: Record<string, InputHistoryNamespace>;
};

type InputHistoryStoreState = InputHistorySnapshot & {
  applyEntryLimit: (limit: number) => void;
  applyScope: (scope: InputHistoryScope) => void;
  appendSubmissions: (identity: InputHistoryIdentity, submissions: readonly InputHistorySubmission[]) => void;
  clearSession: (identity: InputHistoryIdentity) => void;
};

const STORAGE_KEY = 'openchamber-input-history.v1';
const GLOBAL_NAMESPACE_LIMIT = 8;
const SESSION_NAMESPACE_LIMIT = 50;
const QUOTA_RETRY_LIMITS = [40, 25, 10, 5, 1] as const;
const EMPTY_ENTRIES: readonly InputHistoryEntry[] = Object.freeze([]);

let inMemoryStorageValue: string | null = null;
let touchSequence = 0;

const createEmptySnapshot = (
  scope: InputHistoryScope = DEFAULT_INPUT_HISTORY_SCOPE,
  entryLimit = DEFAULT_INPUT_HISTORY_LIMIT,
): InputHistorySnapshot => ({
  entryLimit,
  scope,
  globalBuckets: {},
  sessionBuckets: {},
});

const getNextTimestamp = (): number => {
  touchSequence += 1;
  return Date.now() * 1000 + touchSequence;
};

const createGlobalBucketKey = (runtimeKey: string): string => JSON.stringify([runtimeKey]);

const createSessionBucketKey = (runtimeKey: string, directory: string, sessionId: string): string => (
  JSON.stringify([runtimeKey, directory, sessionId])
);

const getDurableStorage = (): Storage | null => {
  try {
    return globalThis.window?.localStorage ?? null;
  } catch {
    return null;
  }
};

const readPersistedValue = (): string | null => {
  const storage = getDurableStorage();
  const fallback = pendingWrite ? JSON.stringify(toEnvelope(pendingWrite.base)) : inMemoryStorageValue;
  if (!storage) return fallback;
  try {
    return storage.getItem(STORAGE_KEY) ?? (pendingWrite ? null : inMemoryStorageValue);
  } catch {
    return fallback;
  }
};

const rawNamespaceRecordSchema = z.record(z.string(), z.unknown());

type RawNamespaceRecord = z.infer<typeof rawNamespaceRecordSchema>;

const attachmentSchema = z.object({
  key: z.string().min(1),
  source: z.union([z.literal('file-url'), z.literal('vscode-file')]),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().finite().nonnegative(),
  reference: z.string().min(1),
});

const entrySchema = z.object({
  text: z.string(),
  attachmentKeys: z.array(z.string()),
  restorableAttachments: z.array(attachmentSchema),
  submittedAt: z.number().finite().nonnegative(),
});

const namespaceSchema = z.object({
  touchedAt: z.number().finite().nonnegative(),
  entries: z.array(z.unknown()),
});

const parseBucketKey = (value: string, expectedLength: 1 | 3): string[] | null => {
  try {
    const parsed = JSON.parse(value);
    const keySchema = expectedLength === 1
      ? z.tuple([z.string().trim().min(1)])
      : z.tuple([z.string().trim().min(1), z.string().trim().min(1), z.string().trim().min(1)]);
    const result = keySchema.safeParse(parsed);
    if (!result.success) return null;
    if (expectedLength === 3) {
      const directory = normalizePath(result.data[1]);
      if (!directory || directory !== result.data[1]) return null;
    }
    return result.data;
  } catch {
    return null;
  }
};

const parseNamespaces = (
  value: RawNamespaceRecord,
  expectedKeyLength: 1 | 3,
): Record<string, InputHistoryNamespace> => {
  const parsedEntries: Array<[string, InputHistoryNamespace]> = [];
  for (const [key, namespaceValue] of Object.entries(value)) {
    if (!parseBucketKey(key, expectedKeyLength)) continue;
    const namespaceResult = namespaceSchema.safeParse(namespaceValue);
    if (!namespaceResult.success) continue;
    const entries = namespaceResult.data.entries
      .map((entry) => entrySchema.safeParse(entry))
      .filter((result) => result.success)
      .map((result) => result.data);
    parsedEntries.push([key, { touchedAt: namespaceResult.data.touchedAt, entries }]);
  }
  return Object.fromEntries(parsedEntries);
};

const readDurableSnapshot = (): InputHistorySnapshot => {
  const raw = readPersistedValue();
  if (raw === null) return createEmptySnapshot();
  try {
    const parsed = JSON.parse(raw);
    const envelopeResult = z.object({
      version: z.literal(1),
      entryLimit: z.number().int().optional(),
      scope: z.union([z.literal('global'), z.literal('session')]).optional(),
      global: rawNamespaceRecordSchema.default({}),
      session: rawNamespaceRecordSchema.default({}),
    }).safeParse(parsed);
    if (!envelopeResult.success) return createEmptySnapshot();
    return {
      entryLimit: isInputHistoryLimit(envelopeResult.data.entryLimit)
        ? envelopeResult.data.entryLimit
        : DEFAULT_INPUT_HISTORY_LIMIT,
      scope: envelopeResult.data.scope ?? DEFAULT_INPUT_HISTORY_SCOPE,
      globalBuckets: parseNamespaces(envelopeResult.data.global, 1),
      sessionBuckets: parseNamespaces(envelopeResult.data.session, 3),
    };
  } catch {
    const storage = getDurableStorage();
    if (storage) {
      try {
        storage.removeItem(STORAGE_KEY);
      } catch {
        // Ignore durable cleanup failures.
      }
    }
    inMemoryStorageValue = null;
    return createEmptySnapshot();
  }
};

// Failed writes remain local authority, but unrelated writes from another tab
// still participate in the next mutation. Keep bounded snapshots, not a retry log.
let pendingWrite: { base: InputHistorySnapshot; value: InputHistorySnapshot } | null = null;
let lastDurableSnapshot = createEmptySnapshot();

const reconcilePendingBuckets = (
  durable: InputHistorySnapshot['sessionBuckets'],
  base: InputHistorySnapshot['sessionBuckets'],
  local: InputHistorySnapshot['sessionBuckets'],
): InputHistorySnapshot['sessionBuckets'] => {
  const result = { ...durable };
  for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
    if (JSON.stringify(base[key]) === JSON.stringify(local[key])) continue;
    const localBucket = local[key];
    if (!localBucket) {
      delete result[key];
      continue;
    }
    const baseEntries = new Set((base[key]?.entries ?? []).map((entry) => JSON.stringify(entry)));
    const localEntries = new Set(localBucket.entries.map((entry) => JSON.stringify(entry)));
    const entries = (durable[key]?.entries ?? []).filter((entry) => {
      const identity = JSON.stringify(entry);
      return !baseEntries.has(identity) || localEntries.has(identity);
    });
    const present = new Set(entries.map((entry) => JSON.stringify(entry)));
    for (const entry of localBucket.entries) {
      const identity = JSON.stringify(entry);
      if (!baseEntries.has(identity) && !present.has(identity)) entries.push(entry);
    }
    entries.sort((left, right) => left.submittedAt - right.submittedAt);
    result[key] = {
      touchedAt: Math.max(localBucket.touchedAt, durable[key]?.touchedAt ?? 0),
      entries,
    };
  }
  return result;
};

const readSnapshot = (): InputHistorySnapshot => {
  const durable = readDurableSnapshot();
  lastDurableSnapshot = durable;
  if (!pendingWrite) return durable;
  const { base, value } = pendingWrite;
  return normalizeSnapshotLimits({
    entryLimit: value.entryLimit === base.entryLimit ? durable.entryLimit : value.entryLimit,
    scope: value.scope === base.scope ? durable.scope : value.scope,
    globalBuckets: reconcilePendingBuckets(durable.globalBuckets, base.globalBuckets, value.globalBuckets),
    sessionBuckets: reconcilePendingBuckets(durable.sessionBuckets, base.sessionBuckets, value.sessionBuckets),
  });
};

const trimEntriesToLimit = (entries: readonly InputHistoryEntry[], limit: number): InputHistoryEntry[] => (
  entries.slice(Math.max(0, entries.length - limit))
);

const limitNamespaces = (
  buckets: Record<string, InputHistoryNamespace>,
  namespaceLimit: number,
  entryLimit: number,
): Record<string, InputHistoryNamespace> => {
  const ranked = Object.entries(buckets)
    .map(([key, namespace]) => [
      key,
      {
        touchedAt: namespace.touchedAt,
        entries: trimEntriesToLimit(namespace.entries, entryLimit),
      },
    ] as const)
    .sort((left, right) => right[1].touchedAt - left[1].touchedAt)
    .slice(0, namespaceLimit);
  return Object.fromEntries(ranked);
};

const normalizeSnapshotLimits = (
  snapshot: InputHistorySnapshot,
  entryLimit = snapshot.entryLimit,
): InputHistorySnapshot => ({
  entryLimit: snapshot.entryLimit,
  scope: snapshot.scope,
  globalBuckets: limitNamespaces(snapshot.globalBuckets, GLOBAL_NAMESPACE_LIMIT, entryLimit),
  sessionBuckets: limitNamespaces(snapshot.sessionBuckets, SESSION_NAMESPACE_LIMIT, entryLimit),
});

const toEnvelope = (snapshot: InputHistorySnapshot): PersistedInputHistoryEnvelope => ({
  version: 1,
  entryLimit: snapshot.entryLimit,
  scope: snapshot.scope,
  global: snapshot.globalBuckets,
  session: snapshot.sessionBuckets,
});

const isQuotaError = (error: Error | DOMException | null | undefined): boolean => {
  if (error instanceof DOMException) return error.name === 'QuotaExceededError';
  return error instanceof Error && /quota/i.test(error.message);
};

const writeSnapshot = (snapshot: InputHistorySnapshot): InputHistorySnapshot => {
  const normalized = normalizeSnapshotLimits(snapshot);
  const serialized = JSON.stringify(toEnvelope(normalized));
  pendingWrite = { base: lastDurableSnapshot, value: normalized };
  const storage = getDurableStorage();

  if (!storage) {
    inMemoryStorageValue = serialized;
    return normalized;
  }

  try {
    storage.setItem(STORAGE_KEY, serialized);
    pendingWrite = null;
    inMemoryStorageValue = serialized;
    return normalized;
  } catch (error) {
    if (!(error instanceof Error) || !isQuotaError(error)) {
      inMemoryStorageValue = serialized;
      return normalized;
    }
  }

  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore stale durable cleanup failures.
  }

  for (const entryLimit of QUOTA_RETRY_LIMITS) {
    const candidate = normalizeSnapshotLimits(normalized, entryLimit);
    const candidateSerialized = JSON.stringify(toEnvelope(candidate));
    try {
      storage.setItem(STORAGE_KEY, candidateSerialized);
      pendingWrite = null;
      inMemoryStorageValue = candidateSerialized;
      return candidate;
    } catch (error) {
      if (!(error instanceof Error) || !isQuotaError(error)) {
        pendingWrite = { base: lastDurableSnapshot, value: candidate };
        inMemoryStorageValue = candidateSerialized;
        return candidate;
      }
    }
  }

  const emptySnapshot = createEmptySnapshot(normalized.scope, normalized.entryLimit);
  const emptySerialized = JSON.stringify(toEnvelope(emptySnapshot));
  try {
    storage.setItem(STORAGE_KEY, emptySerialized);
    pendingWrite = null;
  } catch {
    pendingWrite = { base: lastDurableSnapshot, value: emptySnapshot };
    // The in-memory copy remains the only fallback.
  }
  inMemoryStorageValue = emptySerialized;
  return emptySnapshot;
};

export const createInputHistoryIdentity = (
  runtimeKey: string,
  directory: string,
  sessionId: string,
): InputHistoryIdentity | null => {
  const normalizedRuntimeKey = runtimeKey.trim();
  const normalizedDirectory = normalizePath(directory);
  const normalizedSessionId = sessionId.trim();
  if (!normalizedRuntimeKey || !normalizedDirectory || !normalizedSessionId) return null;
  return {
    runtimeKey: normalizedRuntimeKey,
    directory: normalizedDirectory,
    sessionId: normalizedSessionId,
  };
};

const getAttachmentReference = (attachment: AttachedFile): string | null => {
  if (attachment.source === 'vscode' && attachment.vscodeSource === 'file') {
    return normalizePath(attachment.vscodePath ?? null);
  }
  const candidate = attachment.dataUrl.trim();
  return candidate || null;
};

const canRestoreReference = (reference: string): boolean => {
  if (!reference || reference.startsWith('data:')) return false;
  if ((reference.startsWith('http://') || reference.startsWith('https://')) && reference.includes('?')) {
    return false;
  }
  return true;
};

const buildAttachmentKey = (attachment: AttachedFile): string => {
  const reference = getAttachmentReference(attachment);
  const normalizedReference = reference === null
    ? 'none'
    : reference.startsWith('data:')
      ? 'data'
      : reference.slice(0, 512);
  return [attachment.source, attachment.filename, attachment.mimeType, String(attachment.size), normalizedReference].join('|');
};

const toRestorableAttachment = (attachment: AttachedFile): InputHistoryAttachment | null => {
  const reference = getAttachmentReference(attachment);
  if (!reference || !canRestoreReference(reference)) return null;
  if (attachment.source === 'vscode' && attachment.vscodeSource === 'file') {
    return {
      key: buildAttachmentKey(attachment),
      source: 'vscode-file',
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      reference,
    };
  }
  return {
    key: buildAttachmentKey(attachment),
    source: 'file-url',
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    reference,
  };
};

export const createInputHistorySubmission = (
  text: string,
  attachments: readonly AttachedFile[],
): InputHistorySubmission => ({
  text,
  attachmentKeys: attachments.map(buildAttachmentKey),
  restorableAttachments: attachments
    .map(toRestorableAttachment)
    .filter((attachment): attachment is InputHistoryAttachment => attachment !== null),
});

const areAttachmentsEqual = (
  left: readonly InputHistoryAttachment[],
  right: readonly InputHistoryAttachment[],
): boolean => (
  left.length === right.length
  && left.every((attachment, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && attachment.key === candidate.key
      && attachment.source === candidate.source
      && attachment.filename === candidate.filename
      && attachment.mimeType === candidate.mimeType
      && attachment.size === candidate.size
      && attachment.reference === candidate.reference;
  })
);

const isDuplicateSubmission = (entry: InputHistoryEntry | undefined, submission: InputHistorySubmission): boolean => (
  entry !== undefined
  && entry.text === submission.text
  && entry.attachmentKeys.length === submission.attachmentKeys.length
  && entry.attachmentKeys.every((key, index) => key === submission.attachmentKeys[index])
  && areAttachmentsEqual(entry.restorableAttachments, submission.restorableAttachments)
);

const appendToNamespace = (
  namespace: InputHistoryNamespace | undefined,
  submissions: readonly InputHistorySubmission[],
  touchedAt: number,
  entryLimit: number,
): InputHistoryNamespace => {
  const entries = namespace ? [...namespace.entries] : [];
  for (const submission of submissions) {
    const previous = entries.at(-1);
    if (isDuplicateSubmission(previous, submission)) continue;
    entries.push({
      text: submission.text,
      attachmentKeys: [...submission.attachmentKeys],
      restorableAttachments: submission.restorableAttachments.map((attachment) => ({ ...attachment })),
      submittedAt: getNextTimestamp(),
    });
  }
  return {
    touchedAt,
    entries: trimEntriesToLimit(entries, entryLimit),
  };
};

const initialSnapshot = writeSnapshot(readSnapshot());

export const useInputHistoryStore = create<InputHistoryStoreState>((set) => ({
  ...initialSnapshot,
  applyEntryLimit: (limit) => {
    if (!isInputHistoryLimit(limit)) return;
    set((state) => {
      const latest = readSnapshot();
      if (latest.entryLimit === limit) return { ...state, ...latest };
      const nextSnapshot = writeSnapshot({
        entryLimit: limit,
        scope: latest.scope,
        globalBuckets: latest.globalBuckets,
        sessionBuckets: latest.sessionBuckets,
      });
      return { ...state, ...nextSnapshot };
    });
  },
  applyScope: (scope) => {
    if (!isInputHistoryScope(scope)) return;
    set((state) => {
      const latest = readSnapshot();
      if (latest.scope === scope) return { ...state, ...latest };
      const nextSnapshot = writeSnapshot({
        entryLimit: latest.entryLimit,
        scope,
        globalBuckets: latest.globalBuckets,
        sessionBuckets: latest.sessionBuckets,
      });
      return { ...state, ...nextSnapshot };
    });
  },
  appendSubmissions: (identity, submissions) => {
    if (submissions.length === 0) return;
    set((state) => {
      const latest = readSnapshot();
      const touchedAt = getNextTimestamp();
      const globalKey = createGlobalBucketKey(identity.runtimeKey);
      const sessionKey = createSessionBucketKey(identity.runtimeKey, identity.directory, identity.sessionId);
      const nextSnapshot = writeSnapshot({
        entryLimit: latest.entryLimit,
        scope: latest.scope,
        globalBuckets: {
          ...latest.globalBuckets,
          [globalKey]: appendToNamespace(latest.globalBuckets[globalKey], submissions, touchedAt, latest.entryLimit),
        },
        sessionBuckets: {
          ...latest.sessionBuckets,
          [sessionKey]: appendToNamespace(latest.sessionBuckets[sessionKey], submissions, touchedAt, latest.entryLimit),
        },
      });
      return { ...state, ...nextSnapshot };
    });
  },
  clearSession: (identity) => {
    set((state) => {
      const latest = readSnapshot();
      const sessionKey = createSessionBucketKey(identity.runtimeKey, identity.directory, identity.sessionId);
      if (!(sessionKey in latest.sessionBuckets)) return { ...state, ...latest };
      const sessionBuckets = { ...latest.sessionBuckets };
      delete sessionBuckets[sessionKey];
      const nextSnapshot = writeSnapshot({
        entryLimit: latest.entryLimit,
        scope: latest.scope,
        globalBuckets: latest.globalBuckets,
        sessionBuckets,
      });
      return { ...state, ...nextSnapshot };
    });
  },
}));

export const selectInputHistoryEntries = (
  state: Pick<InputHistoryStoreState, 'scope' | 'globalBuckets' | 'sessionBuckets'>,
  identity: InputHistoryIdentity | null,
): readonly InputHistoryEntry[] => {
  if (!identity) return EMPTY_ENTRIES;
  if (state.scope === 'session') {
    return state.sessionBuckets[createSessionBucketKey(identity.runtimeKey, identity.directory, identity.sessionId)]?.entries ?? EMPTY_ENTRIES;
  }
  return state.globalBuckets[createGlobalBucketKey(identity.runtimeKey)]?.entries ?? EMPTY_ENTRIES;
};
