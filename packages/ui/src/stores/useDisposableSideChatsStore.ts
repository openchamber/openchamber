import type { Session } from '@opencode-ai/sdk/v2';
import { create } from 'zustand';

import { getDisposableSideChatParentID, isDisposableSideChat } from '@/lib/opencode/sideChatMetadata';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getSafeStorage } from './utils/safeStorage';

const STORAGE_KEY = 'oc.disposable-side-chats.v1';
const MAX_ENTRIES = 50;
const MAX_RUNTIME_NAMESPACES = 8;
const CHANNEL_NAME = 'oc.disposable-side-chats.v1';

export type DisposableSideChatPhase = 'opening' | 'open' | 'cleanup-pending' | 'promotion-pending';
export type DisposableSideChatEntry = {
  runtimeKey: string;
  directory: string;
  parentSessionId: string;
  sideSessionId: string | null;
  phase: DisposableSideChatPhase;
  updatedAt: number;
  revision?: number;
};
type RegistryTombstone = { key: string; revision: number };

type Target = Pick<DisposableSideChatEntry, 'runtimeKey' | 'directory' | 'parentSessionId'>;
type Identity = Target & { sideSessionId: string };
type ParsedRegistry = { status: 'missing' | 'error'; entries: []; tombstones: [] }
  | { status: 'ready'; entries: DisposableSideChatEntry[]; tombstones: RegistryTombstone[] };
type State = {
  entries: Map<string, DisposableSideChatEntry>;
  entryKeyByParent: Map<string, string>;
  entryKeyBySide: Map<string, string>;
  mutationRevision: number;
  tombstones: Map<string, number>;
  runtimeGeneration: number;
  activeRuntimeKey: string;
  hydrationStatus: ParsedRegistry['status'];
  beginOpening: (target: Target) => string | null;
  cancelOpening: (key: string, expectedRuntimeKey: string) => void;
  bindSideSession: (key: string, sideSessionId: string, expectedRuntimeKey: string) => string | null;
  setPhase: (identity: Identity, phase: DisposableSideChatPhase) => void;
  complete: (identity: Identity) => void;
  completePromotion: (identity: Identity) => void;
  reconcileNotFound: (identity: Identity) => void;
  reconcileSessions: (sessions: Session[], runtimeKey: string) => void;
  findByParent: (target: Target) => DisposableSideChatEntry | null;
  findBySide: (runtimeKey: string, directory: string, sideSessionId: string) => DisposableSideChatEntry | null;
  serialize: () => string;
  hydrateSerialized: (serialized: string | null, expectedRuntimeKey: string) => void;
  hydrateFrom: (read: () => string | null | Promise<string | null>, expectedRuntimeKey: string) => Promise<void>;
  resetForRuntimeSwitch: (runtimeKey: string) => void;
  reconcileSerialized: (serialized: string | null) => void;
};

const storage = getSafeStorage();
const isPhase = (value: unknown): value is DisposableSideChatPhase => (
  value === 'opening' || value === 'open' || value === 'cleanup-pending' || value === 'promotion-pending'
);
const normalizeTarget = (target: Target): Target | null => {
  const runtimeKey = target.runtimeKey.trim();
  const directory = normalizePath(target.directory);
  const parentSessionId = target.parentSessionId.trim();
  return runtimeKey && directory && parentSessionId ? { runtimeKey, directory, parentSessionId } : null;
};
const keyFor = (entry: DisposableSideChatEntry): string => JSON.stringify([
  entry.runtimeKey, entry.directory, entry.parentSessionId, entry.sideSessionId ?? '',
]);
const parentKeyFor = (target: Target): string => JSON.stringify([
  target.runtimeKey, target.directory, target.parentSessionId,
]);
const sideKeyFor = (runtimeKey: string, directory: string, sideSessionId: string): string => JSON.stringify([
  runtimeKey, directory, sideSessionId,
]);
const normalizeEntry = (value: unknown): DisposableSideChatEntry | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Partial<DisposableSideChatEntry>;
  const target = normalizeTarget({
    runtimeKey: typeof entry.runtimeKey === 'string' ? entry.runtimeKey : '',
    directory: typeof entry.directory === 'string' ? entry.directory : '',
    parentSessionId: typeof entry.parentSessionId === 'string' ? entry.parentSessionId : '',
  });
  if (!target || target.directory !== entry.directory || !isPhase(entry.phase)) return null;
  if (entry.sideSessionId !== null && typeof entry.sideSessionId !== 'string') return null;
  const sideSessionId = entry.sideSessionId?.trim() || null;
  if (entry.phase !== 'opening' && !sideSessionId) return null;
  if (typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt)) return null;
  const revision = typeof entry.revision === 'number' && Number.isFinite(entry.revision) ? entry.revision : entry.updatedAt;
  return { ...target, sideSessionId, phase: entry.phase, updatedAt: entry.updatedAt, revision };
};
const boundEntries = (entries: Iterable<DisposableSideChatEntry>): Map<string, DisposableSideChatEntry> => {
  const byParent = new Map<string, DisposableSideChatEntry>();
  for (const entry of entries) {
    const parentKey = JSON.stringify([entry.runtimeKey, entry.directory, entry.parentSessionId]);
    const existing = byParent.get(parentKey);
    if (!existing
      || (existing.revision ?? existing.updatedAt) < (entry.revision ?? entry.updatedAt)
      || ((existing.revision ?? existing.updatedAt) === (entry.revision ?? entry.updatedAt) && keyFor(existing) < keyFor(entry))) {
      byParent.set(parentKey, entry);
    }
  }
  const unresolved = new Set([...byParent.values()]
    .filter((entry) => entry.phase === 'cleanup-pending' || entry.phase === 'promotion-pending'));
  const newestRuntimes = new Set([...byParent.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((entry) => entry.runtimeKey)
    .filter((runtimeKey, index, runtimeKeys) => runtimeKeys.indexOf(runtimeKey) === index)
    .slice(0, MAX_RUNTIME_NAMESPACES));
  const bounded = [...byParent.values()]
    .filter((entry) => unresolved.has(entry) || newestRuntimes.has(entry.runtimeKey))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .filter((entry, index) => unresolved.has(entry) || index < MAX_ENTRIES);
  return new Map(bounded.map((entry) => [keyFor(entry), entry]));
};
export const parseDisposableSideChatsRegistry = (serialized: string | null): ParsedRegistry => {
  if (serialized === null) return { status: 'missing', entries: [], tombstones: [] };
  try {
    const parsed = JSON.parse(serialized) as { version?: unknown; entries?: unknown; tombstones?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return { status: 'error', entries: [], tombstones: [] };
    const entries = parsed.entries.map(normalizeEntry);
    if (entries.some((entry) => entry === null)) return { status: 'error', entries: [], tombstones: [] };
    const tombstones = (parsed.tombstones ?? []) as unknown;
    if (!Array.isArray(tombstones)) return { status: 'error', entries: [], tombstones: [] };
    const normalizedTombstones: RegistryTombstone[] = [];
    for (const value of tombstones) {
      if (!value || typeof value !== 'object' || typeof (value as RegistryTombstone).key !== 'string'
        || typeof (value as RegistryTombstone).revision !== 'number' || !Number.isFinite((value as RegistryTombstone).revision)) {
        return { status: 'error', entries: [], tombstones: [] };
      }
      normalizedTombstones.push(value as RegistryTombstone);
    }
    return { status: 'ready', entries: [...boundEntries(entries as DisposableSideChatEntry[]).values()], tombstones: normalizedTombstones };
  } catch {
    return { status: 'error', entries: [], tombstones: [] };
  }
};
const serialize = (entries: Map<string, DisposableSideChatEntry>, tombstones: Map<string, number>) => JSON.stringify({
  version: 1, entries: [...entries.values()], tombstones: [...tombstones].map(([key, revision]) => ({ key, revision })),
});
let channel: BroadcastChannel | null = null;
const persist = (entries: Map<string, DisposableSideChatEntry>, tombstones: Map<string, number>) => {
  const value = serialize(entries, tombstones);
  storage.setItem(STORAGE_KEY, value);
  channel?.postMessage(value);
};
const buildIndexes = (entries: Map<string, DisposableSideChatEntry>) => {
  const entryKeyByParent = new Map<string, string>();
  const entryKeyBySide = new Map<string, string>();
  for (const [key, entry] of entries) {
    entryKeyByParent.set(parentKeyFor(entry), key);
    if (entry.sideSessionId) entryKeyBySide.set(sideKeyFor(entry.runtimeKey, entry.directory, entry.sideSessionId), key);
  }
  return { entryKeyByParent, entryKeyBySide };
};
const entriesPatch = (entries: Map<string, DisposableSideChatEntry>) => ({ entries, ...buildIndexes(entries) });
const findParent = (state: Pick<State, 'entries' | 'entryKeyByParent'>, target: Target) => {
  const normalized = normalizeTarget(target);
  if (!normalized) return null;
  const key = (state.entryKeyByParent ?? buildIndexes(state.entries).entryKeyByParent).get(parentKeyFor(normalized));
  return key ? state.entries.get(key) ?? null : null;
};
const findSide = (state: Pick<State, 'entries' | 'entryKeyBySide'>, runtimeKey: string, directory: string, sideSessionId: string) => {
  const normalizedDirectory = normalizePath(directory);
  if (!runtimeKey || !normalizedDirectory || !sideSessionId) return null;
  const key = (state.entryKeyBySide ?? buildIndexes(state.entries).entryKeyBySide)
    .get(sideKeyFor(runtimeKey, normalizedDirectory, sideSessionId));
  return key ? state.entries.get(key) ?? null : null;
};
const parsedInitial = parseDisposableSideChatsRegistry(storage.getItem(STORAGE_KEY));
const initialEntries = parsedInitial.status === 'ready' ? boundEntries(parsedInitial.entries) : new Map();
const initialTombstones = new Map(parsedInitial.status === 'ready'
  ? parsedInitial.tombstones.map(({ key, revision }) => [key, revision] as const)
  : []);
const mergeRegistry = (state: State, parsed: ParsedRegistry & { tombstones?: RegistryTombstone[] }) => {
  if (parsed.status !== 'ready') return null;
  const entries = new Map(state.entries);
  const tombstones = new Map(state.tombstones);
  for (const tombstone of parsed.tombstones ?? []) {
    const previous = tombstones.get(tombstone.key) ?? 0;
    if (tombstone.revision > previous) tombstones.set(tombstone.key, tombstone.revision);
  }
  for (const entry of parsed.entries) {
    const key = keyFor(entry);
    const current = entries.get(key);
    const revision = entry.revision ?? entry.updatedAt;
    if ((tombstones.get(key) ?? 0) >= revision) continue;
    const currentRevision = current?.revision ?? current?.updatedAt ?? 0;
    if (!current || currentRevision < revision
      || (currentRevision === revision && JSON.stringify(current) < JSON.stringify(entry))) entries.set(key, entry);
  }
  for (const [key, revision] of tombstones) {
    const current = entries.get(key);
    if (current && (current.revision ?? current.updatedAt) <= revision) entries.delete(key);
  }
  return { entries: boundEntries(entries.values()), tombstones };
};

export const useDisposableSideChatsStore = create<State>((set, get) => ({
  ...entriesPatch(initialEntries),
  tombstones: initialTombstones,
  mutationRevision: 0,
  runtimeGeneration: 0,
  activeRuntimeKey: getRuntimeKey(),
  hydrationStatus: parsedInitial.status,
  beginOpening: (target) => {
    const normalized = normalizeTarget(target);
    if (!normalized) return null;
    const existing = findParent(get(), normalized);
    if (existing) return keyFor(existing);
    const revision = get().mutationRevision + 1;
    const entry = { ...normalized, sideSessionId: null, phase: 'opening' as const, updatedAt: Date.now(), revision };
    const entries = boundEntries([...get().entries.values(), entry]);
    set((state) => ({ ...entriesPatch(entries), mutationRevision: state.mutationRevision + 1 }));
    persist(entries, get().tombstones);
    return keyFor(entry);
  },
  cancelOpening: (key, expectedRuntimeKey) => {
    const state = get();
    const current = state.entries.get(key);
    if (!current || current.phase !== 'opening' || current.runtimeKey !== expectedRuntimeKey
      || state.activeRuntimeKey !== expectedRuntimeKey) return;
    const entries = new Map(state.entries);
    entries.delete(key);
    const revision = state.mutationRevision + 1;
    const tombstones = new Map(state.tombstones).set(key, revision);
    set({ ...entriesPatch(entries), tombstones, mutationRevision: revision });
    persist(entries, tombstones);
  },
  bindSideSession: (key, sideSessionId, expectedRuntimeKey) => {
    const state = get();
    const current = state.entries.get(key);
    const sideId = sideSessionId.trim();
    if (!current || !sideId || current.runtimeKey !== expectedRuntimeKey) return null;
    const revision = state.mutationRevision + 1;
    const entry = { ...current, sideSessionId: sideId, phase: 'open' as const, updatedAt: Date.now(), revision };
    const entries = new Map(state.entries);
    entries.delete(key);
    entries.set(keyFor(entry), entry);
    const tombstones = new Map(state.tombstones).set(key, revision);
    set({ ...entriesPatch(entries), tombstones, mutationRevision: revision });
    persist(entries, tombstones);
    return keyFor(entry);
  },
  setPhase: (identity, phase) => {
    const state = get();
    const current = findSide(state, identity.runtimeKey, identity.directory, identity.sideSessionId);
    if (!current || current.parentSessionId !== identity.parentSessionId || current.phase === phase) return;
    const entries = new Map(state.entries);
    const revision = state.mutationRevision + 1;
    entries.set(keyFor(current), { ...current, phase, updatedAt: Date.now(), revision });
    set({ ...entriesPatch(entries), mutationRevision: revision });
    persist(entries, state.tombstones);
  },
  complete: (identity) => {
    const state = get();
    const current = findSide(state, identity.runtimeKey, identity.directory, identity.sideSessionId);
    if (!current || current.parentSessionId !== identity.parentSessionId) return;
    const entries = new Map(state.entries);
    const key = keyFor(current);
    entries.delete(key);
    const revision = state.mutationRevision + 1;
    const tombstones = new Map(state.tombstones).set(key, revision);
    set({ ...entriesPatch(entries), tombstones, mutationRevision: revision });
    persist(entries, tombstones);
  },
  completePromotion: (identity) => get().complete(identity),
  reconcileNotFound: (identity) => get().complete(identity),
  reconcileSessions: (sessions, runtimeKey) => {
    const state = get();
    const additions: DisposableSideChatEntry[] = [];
    for (const session of sessions) {
      const parentSessionId = getDisposableSideChatParentID(session);
      const directory = sessionDirectory(session);
      if (!parentSessionId || !directory || !session.id) continue;
      const owned = findSide(state, runtimeKey, directory, session.id);
      if (owned?.parentSessionId === parentSessionId) continue;
      additions.push({
        runtimeKey,
        directory,
        parentSessionId,
        sideSessionId: session.id,
        phase: 'open',
        updatedAt: session.time?.updated ?? session.time?.created ?? Date.now(),
        revision: state.mutationRevision + additions.length + 1,
      });
    }
    if (additions.length === 0) return;
    const entries = boundEntries([...state.entries.values(), ...additions]);
    set({ ...entriesPatch(entries), mutationRevision: state.mutationRevision + 1 });
    persist(entries, state.tombstones);
  },
  findByParent: (target) => findParent(get(), target),
  findBySide: (runtimeKey, directory, sideSessionId) => findSide(get(), runtimeKey, directory, sideSessionId),
  serialize: () => serialize(get().entries, get().tombstones),
  hydrateSerialized: (serializedValue, expectedRuntimeKey) => {
    if (get().activeRuntimeKey !== expectedRuntimeKey) return;
    const parsed = parseDisposableSideChatsRegistry(serializedValue);
    if (parsed.status !== 'ready') {
      set({ hydrationStatus: parsed.status });
      return;
    }
    const merged = mergeRegistry(get(), parsed);
    if (merged) set({ ...entriesPatch(merged.entries), tombstones: merged.tombstones, hydrationStatus: 'ready' });
  },
  hydrateFrom: async (read, expectedRuntimeKey) => {
    const start = get();
    const serializedValue = await read();
    const current = get();
    if (current.runtimeGeneration !== start.runtimeGeneration || current.activeRuntimeKey !== expectedRuntimeKey
      || current.mutationRevision !== start.mutationRevision) return;
    current.hydrateSerialized(serializedValue, expectedRuntimeKey);
  },
  resetForRuntimeSwitch: (runtimeKey) => {
    set((state) => ({ activeRuntimeKey: runtimeKey, runtimeGeneration: state.runtimeGeneration + 1, hydrationStatus: 'missing' }));
    void get().hydrateFrom(() => storage.getItem(STORAGE_KEY), runtimeKey);
  },
  reconcileSerialized: (serializedValue) => {
    const parsed = parseDisposableSideChatsRegistry(serializedValue);
    const merged = mergeRegistry(get(), parsed);
    if (!merged) return;
    const maxRevision = Math.max(
      get().mutationRevision,
      ...[...merged.entries.values()].map((entry) => entry.revision ?? entry.updatedAt),
      ...merged.tombstones.values(),
    );
    set({ ...entriesPatch(merged.entries), tombstones: merged.tombstones, mutationRevision: maxRevision });
  },
}));

if (typeof BroadcastChannel !== 'undefined') {
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.addEventListener('message', (event) => {
    if (typeof event.data === 'string') useDisposableSideChatsStore.getState().reconcileSerialized(event.data);
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) useDisposableSideChatsStore.getState().reconcileSerialized(event.newValue);
  });
}

const sessionDirectory = (session: Session): string | null => {
  const value = session as Session & { directory?: string | null; project?: { worktree?: string | null } | null };
  return normalizePath(value.directory) ?? normalizePath(value.project?.worktree);
};
export const isDisposableSideChatSession = (session: Session | null | undefined, runtimeKey = getRuntimeKey()): boolean => {
  if (!session) return false;
  if (isDisposableSideChat(session)) return true;
  const directory = sessionDirectory(session);
  if (!directory) return false;
  const state = useDisposableSideChatsStore.getState();
  if (findSide(state, runtimeKey, directory, session.id)) return true;
  const parentSessionId = (session as Session & { parentID?: string | null }).parentID;
  return Boolean(parentSessionId && findParent(state, { runtimeKey, directory, parentSessionId })?.phase === 'opening');
};
export const isDiscoverableSession = (session: Session, runtimeKey = getRuntimeKey()): boolean => (
  !isDisposableSideChatSession(session, runtimeKey)
);
export const filterDiscoverableSessions = (sessions: Session[], runtimeKey = getRuntimeKey()): Session[] => {
  const result = sessions.filter((session) => isDiscoverableSession(session, runtimeKey));
  return result.length === sessions.length ? sessions : result;
};
