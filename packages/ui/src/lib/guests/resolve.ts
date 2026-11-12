import type { AttachIssueRequest, ResolveRequest } from '@openchamber/sdk';

/**
 * `timeout`: the frame never answered; `unavailable`: no frame could be
 * asked (never loaded, or closed mid-call); `error`: the guest's own answer,
 * whose message is shown to the user as the extension wrote it.
 */
export type GuestResolveOutcome =
  | { ok: true; item: AttachIssueRequest | null }
  | { ok: false; reason: 'timeout' | 'unavailable' }
  | { ok: false; reason: 'error'; message: string };

type GuestResolver = (request: ResolveRequest) => Promise<GuestResolveOutcome>;

/**
 * Which mounted guest frames can answer a `resolve`. A rail pane registers
 * itself once its guest has connected; the composer looks here first and
 * mounts a hidden pane only when nothing is registered for that guest.
 */
const resolvers = new Map<string, GuestResolver>();
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) listener();
};

export const registerGuestResolver = (guestId: string, resolver: GuestResolver): (() => void) => {
  resolvers.set(guestId, resolver);
  notify();
  return () => {
    if (resolvers.get(guestId) === resolver) {
      resolvers.delete(guestId);
      notify();
    }
  };
};

export const getGuestResolver = (guestId: string): GuestResolver | null => resolvers.get(guestId) ?? null;

/** Resolves with the resolver once one is registered, or `null` at the deadline. */
export const waitForGuestResolver = (guestId: string, timeoutMs: number): Promise<GuestResolver | null> => {
  const existing = resolvers.get(guestId);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const finish = (value: GuestResolver | null) => {
      listeners.delete(check);
      clearTimeout(timer);
      resolve(value);
    };
    const check = () => {
      const resolver = resolvers.get(guestId);
      if (resolver) finish(resolver);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    listeners.add(check);
  });
};
