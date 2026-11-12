import {
  GUEST_GENERATE_LATE_KEEP_MS,
  GUEST_GENERATE_LATE_MAX,
  isGenerateResult,
  type GenerateRequest,
  type GuestHostSurface,
  type HostMessage,
  type LateGenerateResult,
} from '@openchamber/sdk';

import { guestMay, isGuestActive } from './capabilities.ts';
import { useGuestsStore } from './store.ts';
import type { InstalledGuest } from './types.ts';

/**
 * Where a `generate` was asked. Its late outcome goes only to a frame with the
 * same owner: same runtime, same installation of the extension, same surface
 * and same project, so it shows up where the user pressed the button.
 */
export type GenerateOwner = {
  runtimeKey: string;
  guestId: string;
  storageId: string | null;
  surface: GuestHostSurface;
  directory: string | null;
};

type GenerateResultListener = {
  /** The listening frame's owner now; read on every delivery, since a frame can follow a project switch. */
  owner: () => GenerateOwner;
  /** Post the outcome to the frame. `false` when the frame cannot take it now; the outcome stays kept. */
  deliver: (result: LateGenerateResult) => boolean;
};

type Catalog = { status: string; runtimeKey: string; guests: InstalledGuest[] };

type Kept = { owner: GenerateOwner; result: LateGenerateResult; keptAt: number; size: number };

// Every kept answer together. One answer is at most ~330 000 characters
// (prompt, system and text limits), so this holds several full-size ones.
const KEPT_CHARACTERS_MAX = 2_000_000;

const sameOwner = (a: GenerateOwner, b: GenerateOwner): boolean => (
  a.runtimeKey === b.runtimeKey && a.guestId === b.guestId && a.storageId === b.storageId
  && a.surface === b.surface && a.directory === b.directory
);

const resultSize = (result: LateGenerateResult): number => (
  result.request.prompt.length + (result.request.system?.length ?? 0) + (result.ok ? result.result.text.length : result.error.length)
);

/**
 * What the reply to a `generate` call says, for keeping. `null` for a reply
 * that is no `generate` answer.
 */
export const lateGenerateResult = (request: GenerateRequest, reply: HostMessage): LateGenerateResult | null => {
  if (reply.type !== 'result') return null;
  if (!reply.ok) return { request, ok: false, code: reply.code, error: reply.error };
  return isGenerateResult(reply.payload) ? { request, ok: true, result: { text: reply.payload.text } } : null;
};

/**
 * Keeps `generate` outcomes whose frame was gone when the model answered and
 * hands each one, once, to the next frame of the same owner that listens.
 * Memory only, per window: a reload or another window starts empty, and the
 * request itself never outlives the window that sent it.
 */
export const createGuestGenerateResults = (deps: {
  now: () => number;
  readCatalog: () => Catalog;
  subscribeCatalog: (listener: () => void) => () => void;
}) => {
  let kept: Kept[] = [];
  const listeners: GenerateResultListener[] = [];
  let stopCatalog: (() => void) | null = null;

  // Only a loaded catalog of the same runtime can say the extension is gone,
  // disabled, reinstalled or no longer allowed to use the model; while it
  // loads or after a runtime switch, nothing is dropped for that reason.
  const ownerRevoked = (owner: GenerateOwner): boolean => {
    const catalog = deps.readCatalog();
    if (catalog.status !== 'ready' || catalog.runtimeKey !== owner.runtimeKey) return false;
    const guest = catalog.guests.find((entry) => entry.id === owner.guestId);
    return !guest || !isGuestActive(guest) || !guestMay(guest, 'model') || (guest.storageId ?? null) !== owner.storageId;
  };

  const settle = (): void => {
    if (kept.length > 0 && !stopCatalog) stopCatalog = deps.subscribeCatalog(prune);
    if (kept.length === 0 && stopCatalog) {
      stopCatalog();
      stopCatalog = null;
    }
  };

  function prune(): void {
    const now = deps.now();
    const next = kept.filter((entry) => now - entry.keptAt < GUEST_GENERATE_LATE_KEEP_MS && !ownerRevoked(entry.owner));
    if (next.length !== kept.length) kept = next;
    settle();
  }

  const offer = (owner: GenerateOwner, result: LateGenerateResult): boolean => {
    for (let index = listeners.length - 1; index >= 0; index -= 1) {
      const listener = listeners[index];
      if (sameOwner(listener.owner(), owner) && listener.deliver(result)) return true;
    }
    return false;
  };

  const keep = (owner: GenerateOwner, result: LateGenerateResult): void => {
    prune();
    if (ownerRevoked(owner) || offer(owner, result)) return;
    kept.push({ owner, result, keptAt: deps.now(), size: resultSize(result) });
    const sameGuest = kept.filter((entry) => entry.owner.runtimeKey === owner.runtimeKey && entry.owner.guestId === owner.guestId);
    if (sameGuest.length > GUEST_GENERATE_LATE_MAX) {
      const dropped = new Set(sameGuest.slice(0, sameGuest.length - GUEST_GENERATE_LATE_MAX));
      kept = kept.filter((entry) => !dropped.has(entry));
    }
    let total = kept.reduce((sum, entry) => sum + entry.size, 0);
    while (total > KEPT_CHARACTERS_MAX && kept.length > 1) {
      total -= kept[0].size;
      kept = kept.slice(1);
    }
    settle();
  };

  const listen = (listener: GenerateResultListener): (() => void) => {
    listeners.push(listener);
    prune();
    const owner = listener.owner();
    const waiting = kept.filter((entry) => sameOwner(entry.owner, owner));
    const delivered = new Set<Kept>();
    for (const entry of waiting) {
      if (!listener.deliver(entry.result)) break;
      delivered.add(entry);
    }
    if (delivered.size > 0) {
      kept = kept.filter((entry) => !delivered.has(entry));
      settle();
    }
    return () => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    };
  };

  return { keep, listen };
};

export const guestGenerateResults = createGuestGenerateResults({
  now: Date.now,
  readCatalog: () => useGuestsStore.getState(),
  subscribeCatalog: (listener) => useGuestsStore.subscribe(listener),
});
