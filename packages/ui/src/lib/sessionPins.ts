import { z } from 'zod';
import { parseMetadata } from '@/lib/metadataParse';
import type { Metadata, Session } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import { DEFAULT_PIN_LIST } from '@/lib/sidebarSections';

export const getPinnedSessionKey = (runtimeKey: string, directory: string, sessionId: string): string | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!runtimeKey || !normalizedDirectory || !sessionId) return null;
  return JSON.stringify([runtimeKey, normalizedDirectory, sessionId]);
};

const pinnedKeyCache = new Map<string, Map<string, Map<string, string | null>>>();

const cachedPinnedSessionKey = (runtimeKey: string, directory: string, sessionId: string): string | null => {
  let byDirectory = pinnedKeyCache.get(runtimeKey);
  if (!byDirectory) {
    byDirectory = new Map();
    pinnedKeyCache.set(runtimeKey, byDirectory);
  }
  let bySession = byDirectory.get(directory);
  if (!bySession) {
    bySession = new Map();
    byDirectory.set(directory, bySession);
  }
  let key = bySession.get(sessionId);
  if (key === undefined) {
    key = getPinnedSessionKey(runtimeKey, directory, sessionId);
    bySession.set(sessionId, key);
  }
  return key;
};

export const isSessionPinned = (ids: ReadonlySet<string>, directory: string | null | undefined, sessionId: string): boolean => {
  if (!directory || ids.size === 0) return false;
  const key = cachedPinnedSessionKey(getRuntimeKey(), directory, sessionId);
  return key ? ids.has(key) : false;
};

const pinnedSchema = z.object({ openchamber: z.object({ pinned: z.object({ at: z.number(), list: z.string().min(1).optional() }) }) });

export const isSessionPinnedInMetadata = (session: Session | null | undefined): boolean => (
  parseMetadata(pinnedSchema, session?.metadata).success
);

export const isPinnedMetadata = (metadata: Metadata): boolean => pinnedSchema.safeParse(metadata).success;

export const getSessionPinList = (session: Session | null | undefined): string | null => {
  const parsed = parseMetadata(pinnedSchema, session?.metadata);
  if (!parsed.success) return null;
  return parsed.data.openchamber.pinned.list ?? DEFAULT_PIN_LIST;
};

const openchamberSchema = z.object({ openchamber: z.record(z.string(), z.json()) });

export function withSessionPinned(metadata: Metadata, pin: boolean, now: number, list: string | null = null): Metadata {
  const namespace = openchamberSchema.safeParse(metadata).data?.openchamber ?? {};
  const current = pinnedSchema.safeParse(metadata).data?.openchamber.pinned;
  if (!pin) {
    if (!current) return metadata;
    const rest = { ...namespace };
    delete rest.pinned;
    return { ...metadata, openchamber: rest };
  }
  const nextList = list && list !== DEFAULT_PIN_LIST ? list : undefined;
  if (current && current.list === nextList) return metadata;
  const at = current?.at ?? now;
  if (!nextList) return { ...metadata, openchamber: { ...namespace, pinned: { at } } };
  return { ...metadata, openchamber: { ...namespace, pinned: { at, list: nextList } } };
}
