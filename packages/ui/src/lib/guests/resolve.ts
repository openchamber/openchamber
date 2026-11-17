import type { AttachIssueRequest, ResolveRequest } from '@openchamber/sdk';

export type GuestResolveOutcome =
  | { ok: true; item: AttachIssueRequest | null }
  | { ok: false; reason: 'timeout' | 'unavailable' }
  | { ok: false; reason: 'error'; message: string };

type GuestResolver = (request: ResolveRequest) => Promise<GuestResolveOutcome>;

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
