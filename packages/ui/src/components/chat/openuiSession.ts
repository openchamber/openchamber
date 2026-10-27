import React from 'react';
import type { RendererProps } from '@openuidev/react-lang';

import { subscribeDirectorySessionMessages } from '@/sync/child-store';
import type { Part } from '@/lib/opencode/model';
import { openuiPrompt } from '@/lib/opencode/tools';
import { useDirectoryStore } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { getRuntimeKey, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import type { OpenUIOwner } from './openui/openuiHost';

type OpenUIState = Parameters<NonNullable<RendererProps['onStateUpdate']>>[0];

const MAX_ENTRIES = 100;
const MAX_PARTS = 100;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

type OpenUISessionOwner = {
  runtimeKey: string;
  directory: string;
  sessionId: string;
};

export type PartLease = {
  owner: OpenUISession;
  messageId: string;
  partId: string;
  generation: number;
  isCurrent: () => boolean;
};

type OpenUIFieldLease = {
  initialState?: OpenUIState;
  save: (snapshot: OpenUIState) => boolean;
  retain: () => () => void;
  isCurrent: () => boolean;
};

type PartLineage = {
  generation: number;
  source: string;
  bytes: number;
  touched: number;
  authoritative: boolean;
};

type SnapshotEntry = {
  key: string;
  partIdentity: string;
  snapshot?: OpenUIState;
  bytes: number;
  consumers: number;
  touched: number;
};

const sourceBytes = (source: string): number => new TextEncoder().encode(source).byteLength;
const partIdentity = (messageId: string, partId: string): string => `${messageId}\u0000${partId}`;

const cloneSnapshot = (snapshot: OpenUIState): OpenUIState | undefined => {
  try {
    return structuredClone(snapshot);
  } catch {
    return undefined;
  }
};

const measureSnapshot = (snapshot: OpenUIState): number | null => {
  try {
    return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  } catch {
    return null;
  }
};

/** Owns transient renderer state for the session currently visible in one chat column. */
export class OpenUISession {
  readonly owner: OpenUISessionOwner;
  private readonly parts = new Map<string, PartLineage>();
  private readonly partIdsByMessage = new Map<string, Set<string>>();
  private readonly entries = new Map<string, SnapshotEntry>();
  private sequence = 0;
  private totalSourceBytes = 0;
  private totalSnapshotBytes = 0;
  private disposed = false;
  private lifecycleLease: symbol | null = null;
  private trimQueued = false;

  constructor(owner: OpenUISessionOwner) {
    this.owner = owner;
  }

  trackPart(messageId: string, partId: string, canonical: string): PartLease {
    if (this.disposed) return this.createInertLease(messageId, partId);
    const identity = partIdentity(messageId, partId);
    const previous = this.parts.get(identity);
    if (!previous) return this.writePart(messageId, partId, canonical, false, ++this.sequence);
    if (previous.source.startsWith(canonical)) {
      return this.createPartLease(messageId, partId, previous.generation, canonical);
    }
    if (!previous.authoritative && canonical.startsWith(previous.source)) {
      return this.writePart(messageId, partId, canonical, false, previous.generation);
    }
    // A committed directory-store source owns this lineage. A stale render or
    // an abandoned concurrent render cannot rewind or replace it.
    return this.createInertLease(messageId, partId);
  }

  /** Reading a handle is side-effect free; only committed mounts retain entries. */
  field(key: string, lease: PartLease): OpenUIFieldLease {
    const identity = partIdentity(lease.messageId, lease.partId);
    const entryKey = `${identity}\u0000${lease.generation}\u0000${key}`;
    let entry = this.entries.get(entryKey);
    const initialState = lease.isCurrent() && entry?.snapshot !== undefined ? cloneSnapshot(entry.snapshot) : undefined;
    let mounted = false;
    return {
      initialState,
      retain: () => {
        if (!lease.isCurrent()) return () => {};
        entry = this.entries.get(entryKey);
        if (!entry) {
          entry = { key: entryKey, partIdentity: identity, bytes: 0, consumers: 0, touched: ++this.sequence };
          this.entries.set(entryKey, entry);
        }
        const retained = entry;
        mounted = true;
        retained.consumers += 1;
        retained.touched = ++this.sequence;
        this.scheduleTrim();
        return () => {
          if (!mounted) return;
          mounted = false;
          retained.consumers -= 1;
          retained.touched = ++this.sequence;
          this.scheduleTrim();
        };
      },
      save: (snapshot) => {
        if (!mounted || !entry || this.entries.get(entryKey) !== entry || !lease.isCurrent()) return false;
        const bytes = measureSnapshot(snapshot);
        const cloned = bytes !== null && bytes <= MAX_SNAPSHOT_BYTES && this.totalBytes() - entry.bytes + bytes <= MAX_TOTAL_BYTES
          ? cloneSnapshot(snapshot) : undefined;
        if (bytes === null || cloned === undefined) {
          this.totalSnapshotBytes -= entry.bytes;
          entry.snapshot = undefined;
          entry.bytes = 0;
          return false;
        }
        this.totalSnapshotBytes += bytes - entry.bytes;
        entry.snapshot = cloned;
        entry.bytes = bytes;
        entry.touched = ++this.sequence;
        this.scheduleTrim();
        return true;
      },
      isCurrent: lease.isCurrent,
    };
  }

  reconcilePart(messageId: string, partId: string, canonical: string | null): void {
    const identity = partIdentity(messageId, partId);
    const previous = this.parts.get(identity);
    if (!previous) return;
    if (canonical === null) {
      this.removePart(identity);
      return;
    }
    const appended = canonical.startsWith(previous.source);
    const generation = appended ? previous.generation : ++this.sequence;
    this.writePart(messageId, partId, canonical, true, generation);
  }

  reconcileMessage(messageId: string, parts: readonly Part[] | undefined): void {
    const tracked = this.partIdsByMessage.get(messageId);
    if (!tracked) return;
    const current = new Map(parts?.map((part) => [part.id, part]));
    for (const partId of tracked) {
      const part = current.get(partId);
      const canonical = part ? canonicalPartSource(part) : null;
      this.reconcilePart(messageId, partId, canonical);
    }
  }

  reconcileRemovedParts(partsByMessage: Readonly<Record<string, readonly Part[]>>): void {
    for (const messageId of this.partIdsByMessage.keys()) this.reconcileMessage(messageId, partsByMessage[messageId]);
  }

  reconcileAvailableParts(partsByMessage: Readonly<Record<string, readonly Part[]>>): void {
    for (const messageId of this.partIdsByMessage.keys()) {
      if (Object.hasOwn(partsByMessage, messageId)) this.reconcileMessage(messageId, partsByMessage[messageId]);
    }
  }

  reset(): void {
    this.parts.clear();
    this.partIdsByMessage.clear();
    this.entries.clear();
    this.totalSourceBytes = 0;
    this.totalSnapshotBytes = 0;
    this.sequence += 1;
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  retain(): (() => void) | null {
    if (this.disposed) return null;
    const token = Symbol();
    this.lifecycleLease = token;
    return () => {
      // StrictMode reconnects synchronously and replaces this token. Activity
      // leaves a real observation gap, so the old owner must stay revoked.
      queueMicrotask(() => {
        if (this.lifecycleLease === token) this.dispose();
      });
    };
  }

  trimIdle(): void {
    this.trimQueued = false;
    while (this.entries.size > MAX_ENTRIES || this.totalBytes() > MAX_TOTAL_BYTES) {
      const entry = this.oldestIdleEntry();
      if (!entry) break;
      this.removeEntry(entry);
    }
    while (this.parts.size > MAX_PARTS || this.totalBytes() > MAX_TOTAL_BYTES) {
      const identity = this.oldestIdlePart();
      if (!identity) break;
      this.removePart(identity);
    }
  }

  private createPartLease(messageId: string, partId: string, generation: number, source: string): PartLease {
    const identity = partIdentity(messageId, partId);
    return {
      owner: this,
      messageId,
      partId,
      generation,
      isCurrent: () => {
        const current = this.parts.get(identity);
        return !this.disposed && current?.generation === generation && current.source.startsWith(source);
      },
    };
  }

  private writePart(
    messageId: string,
    partId: string,
    source: string,
    authoritative: boolean,
    generation: number,
  ): PartLease {
    const identity = partIdentity(messageId, partId);
    const previous = this.parts.get(identity);
    const appended = previous && generation === previous.generation && source.startsWith(previous.source);
    const bytes = appended ? previous.bytes + sourceBytes(source.slice(previous.source.length)) : sourceBytes(source);
    if (generation !== previous?.generation) this.removePartEntries(identity);
    this.totalSourceBytes += bytes - (previous?.bytes ?? 0);
    this.parts.set(identity, {
      generation,
      source,
      bytes,
      touched: ++this.sequence,
      authoritative: authoritative || previous?.authoritative === true,
    });
    let messageParts = this.partIdsByMessage.get(messageId);
    if (!messageParts) {
      messageParts = new Set();
      this.partIdsByMessage.set(messageId, messageParts);
    }
    messageParts.add(partId);
    if (!previous || generation !== previous.generation || this.totalBytes() > MAX_TOTAL_BYTES) this.scheduleTrim();
    return this.createPartLease(messageId, partId, generation, source);
  }

  private createInertLease(messageId: string, partId: string): PartLease {
    return {
      owner: this,
      messageId,
      partId,
      generation: -1,
      isCurrent: () => false,
    };
  }

  private scheduleTrim(): void {
    if (this.trimQueued) return;
    this.trimQueued = true;
    queueMicrotask(() => this.trimIdle());
  }

  private totalBytes(): number {
    return this.totalSourceBytes + this.totalSnapshotBytes;
  }

  private oldestIdleEntry(): SnapshotEntry | null {
    let oldest: SnapshotEntry | null = null;
    for (const entry of this.entries.values()) {
      if (entry.consumers === 0 && (!oldest || entry.touched < oldest.touched)) oldest = entry;
    }
    return oldest;
  }

  private oldestIdlePart(): string | null {
    let oldest: [string, PartLineage] | null = null;
    for (const part of this.parts) {
      if (this.partHasConsumers(part[0])) continue;
      if (!oldest || part[1].touched < oldest[1].touched) oldest = part;
    }
    return oldest?.[0] ?? null;
  }

  private partHasConsumers(identity: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.partIdentity === identity && entry.consumers > 0) return true;
    }
    return false;
  }

  private removePart(identity: string): void {
    const part = this.parts.get(identity);
    if (!part) return;
    this.parts.delete(identity);
    this.totalSourceBytes -= part.bytes;
    const separator = identity.indexOf('\u0000');
    const messageId = identity.slice(0, separator);
    const partId = identity.slice(separator + 1);
    const messageParts = this.partIdsByMessage.get(messageId);
    messageParts?.delete(partId);
    if (messageParts?.size === 0) this.partIdsByMessage.delete(messageId);
    this.removePartEntries(identity);
  }

  private removePartEntries(identity: string): void {
    for (const entry of this.entries.values()) {
      if (entry.partIdentity === identity) this.removeEntry(entry);
    }
  }

  private removeEntry(entry: SnapshotEntry): void {
    this.entries.delete(entry.key);
    this.totalSnapshotBytes -= entry.bytes;
  }
}

const OpenUISessionContext = React.createContext<OpenUISession | null>(null);

const canonicalPartSource = (part: Part): string | null => {
  if (part.type === 'text' || part.type === 'reasoning') return part.text;
  if (part.type !== 'tool') return null;
  return openuiPrompt(part.tool, part.state)?.source ?? null;
};

/**
 * Retains one renderer field state through virtualization and StrictMode effect
 * replay. Render only reads a snapshot; layout setup retains it and cleanup
 * releases synchronously. Abandoned renders allocate no cache entries.
 */
export function useOpenUIFields(key: string, lease: PartLease | null): OpenUIFieldLease | null {
  const retained = React.useRef<{
    key: string;
    lease: PartLease;
    field: OpenUIFieldLease;
  } | null>(null);
  const current = retained.current;
  const matches = current
    && current.key === key
    && current.lease.owner === lease?.owner
    && current.lease.messageId === lease?.messageId
    && current.lease.partId === lease?.partId
    && current.lease.generation === lease?.generation;
  if (!lease) {
    retained.current = null;
  } else if (!matches) {
    retained.current = { key, lease, field: lease.owner.field(key, lease) };
  }

  const field = retained.current?.field ?? null;
  React.useLayoutEffect(() => {
    return field?.retain();
  }, [field]);
  return field;
}

/** Both entries acquire a draft without owning source lineage or mount leases. */
export function useOpenUIDraft(owner: OpenUIOwner, source: string, fenceStart?: number) {
  const session = useOpenUISession();
  const part = session?.trackPart(owner.messageId, owner.partId, source);
  const key = JSON.stringify([
    owner.runtimeKey, owner.directory, owner.sessionId, owner.messageId,
    owner.partId, part?.generation ?? 0, ...(fenceStart === undefined ? [] : [fenceStart]),
  ]);
  const field = useOpenUIFields(key, part ?? null);
  const [notRetained, setNotRetained] = React.useState(false);
  const onStateUpdate = React.useCallback((snapshot: OpenUIState) => {
    if (field) setNotRetained(!field.save(snapshot));
  }, [field]);
  const isCurrent = React.useCallback(() => field?.isCurrent() ?? true, [field]);
  return { key, initialState: field?.initialState, onStateUpdate, isCurrent, notRetained };
}

const useRuntimeKey = (): string => React.useSyncExternalStore(
  subscribeRuntimeEndpointChanged,
  getRuntimeKey,
  getRuntimeKey,
);

export function OpenUISessionProvider({ sessionId, directory, children }: {
  sessionId: string | null;
  directory: string;
  children: React.ReactNode;
}) {
  const store = useDirectoryStore(directory, { bootstrap: false });
  const enabled = useUIStore((state) => state.agentRenderToolEnabled);
  const runtimeKey = useRuntimeKey();
  const [retainedOwner, setOwner] = React.useState<OpenUISession | null>(null);
  let owner = retainedOwner;
  if (!enabled || !sessionId) {
    owner = null;
  } else if (!owner || owner.isDisposed() || owner.owner.runtimeKey !== runtimeKey
    || owner.owner.directory !== directory || owner.owner.sessionId !== sessionId) {
    // Activity keeps hook state after its effect cleanup retires this owner.
    // A passive-effect replacement lets descendants commit their source
    // fallback first. Replace the owner here before rendering those children.
    owner = new OpenUISession({ runtimeKey, directory, sessionId });
  }
  if (owner !== retainedOwner) setOwner(owner);

  React.useLayoutEffect(() => {
    if (!owner) return;
    const release = owner.retain();
    if (!release) {
      // An unchanged retained subtree can reconnect effects without rendering
      // the provider first. Recover that path in layout setup before paint.
      setOwner(new OpenUISession(owner.owner));
      return;
    }
    const unsubscribeMessages = subscribeDirectorySessionMessages(store, owner.owner.sessionId, (change) => {
      const state = store.getState();
      if (change.reset || change.messagesChanged) {
        // Unmarked part-map writes include ordinary message loads and prompt
        // reconciliation. Compare tracked sources before retiring their leases.
        owner.reconcileRemovedParts(state.part);
        return;
      }
      for (const messageId of change.partMessageIDs) owner.reconcileMessage(messageId, state.part[messageId]);
    });
    // A delta can land between render and setup. Reconcile published buckets;
    // an absent bucket is still uninitialized and cannot revoke its source.
    owner.reconcileAvailableParts(store.getState().part);
    const unsubscribeRuntime = subscribeRuntimeEndpointWillChange(() => owner.reset());
    return () => {
      unsubscribeMessages();
      unsubscribeRuntime();
      release();
    };
  }, [owner, store]);

  return React.createElement(OpenUISessionContext.Provider, { value: owner }, children);
}

export function useOpenUISession(): OpenUISession | null {
  return React.useContext(OpenUISessionContext);
}
