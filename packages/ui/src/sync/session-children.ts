import type { Session } from '@opencode-ai/sdk/v2';

const CHILDREN_CACHE_TTL_MS = 15_000;
const CHILDREN_CACHE_MAX = 100;
const inFlight = new Map<string, Promise<Session[]>>();
const cache = new Map<string, { loadedAt: number; sessions: Session[] }>();

type LoadSessionChildrenInput = {
  runtimeKey: string;
  directory: string;
  sessionID: string;
  request: () => Promise<Session[]>;
  now?: number;
};

const loadKey = (input: Pick<LoadSessionChildrenInput, 'runtimeKey' | 'directory' | 'sessionID'>): string => (
  `${input.runtimeKey}\n${input.directory}\n${input.sessionID}`
);

export const loadSessionChildrenOnDemand = (input: LoadSessionChildrenInput): Promise<Session[]> => {
  const key = loadKey(input);
  const now = input.now ?? Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.loadedAt < CHILDREN_CACHE_TTL_MS) {
    return Promise.resolve(cached.sessions);
  }
  const existing = inFlight.get(key);
  if (existing) return existing;

  const pending = input.request().then((sessions) => {
    cache.delete(key);
    while (cache.size >= CHILDREN_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (typeof oldest !== 'string') break;
      cache.delete(oldest);
    }
    cache.set(key, { loadedAt: Date.now(), sessions });
    return sessions;
  });
  inFlight.set(key, pending);
  pending.then(
    () => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    },
    () => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    },
  );
  return pending;
};

const compareSessionId = (left: Session, right: Session): number => (
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0
);

export const mergeSessionChildren = (
  existing: Session[],
  incoming: Session[],
  parentSessionId: string,
): Session[] => {
  const existingIds = new Set(existing.map((session) => session.id));
  const additions = incoming.filter((session) => (
    Boolean(session?.id)
    && !existingIds.has(session.id)
    && (session as Session & { parentID?: string | null }).parentID === parentSessionId
  ));
  if (additions.length === 0) return existing;
  return [...existing, ...additions].sort(compareSessionId);
};
