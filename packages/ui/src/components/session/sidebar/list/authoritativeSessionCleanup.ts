import type { Session } from '@opencode-ai/sdk/v2';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';

type AuthoritativeSessionIdentity = {
  directory: string;
  sessionId: string;
};

export const buildAuthoritativeSessionIdentityMap = (
  sessions: Session[],
): Map<string, AuthoritativeSessionIdentity> => {
  const identities = new Map<string, AuthoritativeSessionIdentity>();
  for (const session of sessions) {
    const directory = resolveGlobalSessionDirectory(session);
    if (!directory) continue;
    identities.set(session.id, { directory, sessionId: session.id });
  }
  return identities;
};

export const findRemovedAuthoritativeSessions = (
  previous: ReadonlyMap<string, AuthoritativeSessionIdentity> | null,
  current: ReadonlyMap<string, AuthoritativeSessionIdentity>,
): AuthoritativeSessionIdentity[] => {
  if (!previous) return [];
  const removed: AuthoritativeSessionIdentity[] = [];
  previous.forEach((identity, key) => {
    if (!current.has(key)) removed.push(identity);
  });
  return removed;
};
