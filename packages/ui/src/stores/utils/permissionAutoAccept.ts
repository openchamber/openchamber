import type { Session } from "@opencode-ai/sdk/v2/client";
import { getCompatibleSessionParentId } from "@/sync/compat";

export type PermissionLevel = 'manual' | 'auto-accept' | 'full-access';

export type PermissionAutoAcceptMap = Record<string, boolean | PermissionLevel>;

/**
 * Normalize a stored value (boolean or string) to a PermissionLevel.
 * Handles backward compatibility with legacy boolean values.
 */
export const resolvePermissionLevel = (value: boolean | PermissionLevel | undefined): PermissionLevel => {
    if (value === true || value === 'auto-accept') return 'auto-accept';
    if (value === 'full-access') return 'full-access';
    return 'manual';
};

/**
 * Returns true for permission levels that auto-reply to permission requests.
 */
export const isAutoAcceptingLevel = (level: PermissionLevel): boolean => {
    return level === 'auto-accept' || level === 'full-access';
};

const DIRECTORY_WILDCARD = '*';

const encodeBase64 = (value: string): string => {
    try {
        const bytes = new TextEncoder().encode(value);
        let binary = '';
        for (const byte of bytes) {
            binary += String.fromCharCode(byte);
        }
        return btoa(binary);
    } catch {
        return btoa(value);
    }
};

export const normalizeDirectory = (value: string | null | undefined): string | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const normalized = trimmed.replace(/\\/g, '/');
    if (normalized === '/') {
        return '/';
    }
    return normalized.length > 1 ? normalized.replace(/\/+$/g, '') : normalized;
};

export const directoryAcceptKey = (directory: string): string => `${encodeBase64(directory)}/${DIRECTORY_WILDCARD}`;

export const sessionAcceptKey = (sessionID: string, directory: string): string => `${encodeBase64(directory)}/${sessionID}`;

const buildSessionMap = (sessions: Session[]): Map<string, Session> => {
  const map = new Map<string, Session>();
  for (const session of sessions) {
    map.set(session.id, session);
  }
  return map;
};

const resolveLineage = (sessionID: string, sessions: Session[]): string[] => {
  const map = buildSessionMap(sessions);
  const result: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = sessionID;

  while (current && !seen.has(current)) {
    seen.add(current);
    result.push(current);
    const session = map.get(current);
    current = session ? getCompatibleSessionParentId(session) ?? undefined : undefined;
  }

  return result;
};

/**
 * Look up the resolved PermissionLevel for a session, walking the lineage.
 */
export const getPermissionLevel = (input: {
    autoAccept: PermissionAutoAcceptMap;
    sessions: Session[];
    sessionID: string;
    directory: string;
}): PermissionLevel => {
    const { autoAccept, sessions, sessionID, directory } = input;

    for (const id of resolveLineage(sessionID, sessions)) {
        const key = sessionAcceptKey(id, directory);
        if (key in autoAccept) {
            return resolvePermissionLevel(autoAccept[key]);
        }

        // Legacy fallback for pre-directory keys.
        if (id in autoAccept) {
            return resolvePermissionLevel(autoAccept[id]);
        }
    }

    const directoryKey = directoryAcceptKey(directory);
    if (directoryKey in autoAccept) {
        return resolvePermissionLevel(autoAccept[directoryKey]);
    }

    return 'manual';
};

export const autoRespondsPermission = (input: {
  autoAccept: PermissionAutoAcceptMap;
  sessions: Session[];
  sessionID: string;
  directory: string;
}): boolean => {
    return isAutoAcceptingLevel(getPermissionLevel(input));
};

export const isDirectoryAutoAccepting = (autoAccept: PermissionAutoAcceptMap, directory: string): boolean => {
    const key = directoryAcceptKey(directory);
    return isAutoAcceptingLevel(resolvePermissionLevel(autoAccept[key]));
};
