import type { Session } from "@opencode-ai/sdk/v2/client";

export type PermissionAutoAcceptMap = Record<string, boolean>;

const isValidLineageSession = (sessionID: string, value: unknown): value is Session => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const id = typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id.trim() : '';
  return id === sessionID;
};

const buildSessionMap = (sessions: Session[]): Map<string, Session> => {
  const map = new Map<string, Session>();
  for (const session of sessions) {
    if (!isValidLineageSession(typeof session?.id === 'string' ? session.id : '', session)) {
      continue;
    }
    map.set(session.id, session);
  }
  return map;
};

const resolveLineage = (
  sessionID: string,
  sessions: Session[],
  sessionById?: ReadonlyMap<string, Session>,
): { lineage: string[]; complete: boolean } => {
  const map = sessionById ?? buildSessionMap(sessions);
  const lineage: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = sessionID;
  let complete = false;

  while (current && !seen.has(current)) {
    seen.add(current);
    lineage.push(current);
    if (!map.has(current)) {
      return { lineage, complete: false };
    }
    const session = map.get(current);
    if (!isValidLineageSession(current, session)) {
      return { lineage, complete: false };
    }
    current = session.parentID;
  }

  if (!current) {
    complete = true;
  }

  return { lineage, complete };
};

export const autoRespondsPermission = (input: {
  defaultEnabled: boolean;
  autoAccept: PermissionAutoAcceptMap;
  sessions: Session[];
  sessionById?: ReadonlyMap<string, Session>;
  sessionID: string;
}): boolean => {
  const { defaultEnabled, autoAccept, sessions, sessionById, sessionID } = input;
  if (!defaultEnabled && Object.keys(autoAccept).length === 0) return false;
  const { lineage, complete } = resolveLineage(sessionID, sessions, sessionById);

  for (const id of lineage) {
    if (!Object.prototype.hasOwnProperty.call(autoAccept, id)) {
      continue;
    }
    return autoAccept[id] === true;
  }

  return complete ? defaultEnabled : false;
};
