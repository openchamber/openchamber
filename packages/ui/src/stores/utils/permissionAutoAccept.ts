import type { Session } from "@opencode-ai/sdk/v2/client";

export type PermissionAutoAcceptMap = Record<string, boolean>;

const buildSessionMap = (sessions: Session[]): Map<string, Session> => {
  const map = new Map<string, Session>();
  for (const session of sessions) {
    map.set(session.id, session);
  }
  return map;
};

const resolveLineage = (
  sessionID: string,
  sessions: Session[],
  sessionById?: ReadonlyMap<string, Session>,
): string[] => {
  const map = sessionById ?? buildSessionMap(sessions);
  const result: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = sessionID;

  while (current && !seen.has(current)) {
    seen.add(current);
    result.push(current);
    current = map.get(current)?.parentID;
  }

  return result;
};

export const autoRespondsPermission = (input: {
  autoAccept: PermissionAutoAcceptMap;
  sessions: Session[];
  sessionById?: ReadonlyMap<string, Session>;
  sessionID: string;
}): boolean => {
  const { autoAccept, sessions, sessionById, sessionID } = input;
  if (Object.keys(autoAccept).length === 0) return false;
  const lineage = resolveLineage(sessionID, sessions, sessionById);

  for (const id of lineage) {
    if (!Object.prototype.hasOwnProperty.call(autoAccept, id)) {
      continue;
    }
    return autoAccept[id] === true;
  }

  return false;
};
