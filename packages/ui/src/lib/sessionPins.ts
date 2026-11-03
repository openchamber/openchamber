import { z } from 'zod';
import type { Metadata, Session } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import { DEFAULT_PIN_LIST } from '@/lib/sidebarSections';

/**
 * A pin lives in the session's metadata, `session.metadata.openchamber.pinned`,
 * so every client of the server sees it, the way In work state travels. The
 * sidebar and the lists match pins by a key of runtime, directory and session:
 * the same session id can appear under two directories, and a runtime switch
 * must not carry one server's pins onto another.
 */
export const getPinnedSessionKey = (runtimeKey: string, directory: string, sessionId: string): string | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!runtimeKey || !normalizedDirectory || !sessionId) return null;
  return JSON.stringify([runtimeKey, normalizedDirectory, sessionId]);
};

export const isSessionPinned = (ids: ReadonlySet<string>, directory: string | null | undefined, sessionId: string): boolean => {
  if (!directory) return false;
  const key = getPinnedSessionKey(getRuntimeKey(), directory, sessionId);
  return key ? ids.has(key) : false;
};

// `list`: the user's pin list the pin is filed in (Pin to); absent for Pinned.
const pinnedSchema = z.object({ openchamber: z.object({ pinned: z.object({ at: z.number(), list: z.string().min(1).optional() }) }) });

export const isSessionPinnedInMetadata = (session: Session | null | undefined): boolean => (
  pinnedSchema.safeParse(session?.metadata).success
);

/** The pin list a pinned session is filed in, `DEFAULT_PIN_LIST` for Pinned, or null when not pinned. */
export const getSessionPinList = (session: Session | null | undefined): string | null => {
  const parsed = pinnedSchema.safeParse(session?.metadata);
  if (!parsed.success) return null;
  return parsed.data.openchamber.pinned.list ?? DEFAULT_PIN_LIST;
};

const openchamberSchema = z.object({ openchamber: z.record(z.string(), z.json()) });

/**
 * The metadata after the user pinned (`at` = when) or unpinned the session.
 * `list` files the pin in one of the user's pin lists; null is Pinned. Moving
 * a pin to another list keeps the time it was first pinned.
 */
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
