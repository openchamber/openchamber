import type { Session } from "@opencode-ai/sdk/v2/client";

export type PermissionAutoAcceptMap = Record<string, boolean>;

const DIRECTORY_WILDCARD = "*";

const encodeBase64 = (value: string): string => {
    try {
        const bytes = new TextEncoder().encode(value);
        let binary = "";
        for (const byte of bytes) {
            binary += String.fromCharCode(byte);
        }
        return btoa(binary);
    } catch {
        return btoa(value);
    }
};

export const normalizeDirectory = (value: string | null | undefined): string | null => {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const normalized = trimmed.replace(/\\/g, "/");
    if (normalized === "/") {
        return "/";
    }
    return normalized.length > 1 ? normalized.replace(/\/+$/g, "") : normalized;
};

export const directoryAcceptKey = (directory: string): string => `${encodeBase64(directory)}/${DIRECTORY_WILDCARD}`;

export const sessionAcceptKey = (sessionID: string, directory: string): string => `${encodeBase64(directory)}/${sessionID}`;

const resolveLineage = (sessionID: string, sessions: Session[]): string[] => {
    const map = new Map<string, Session>();
    for (const session of sessions) {
        map.set(session.id, session);
    }

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
    sessionID: string;
    directory: string;
}): boolean => {
    const { autoAccept, sessions, sessionID, directory } = input;

    for (const id of resolveLineage(sessionID, sessions)) {
        const key = sessionAcceptKey(id, directory);
        if (key in autoAccept) {
            return autoAccept[key] === true;
        }

        // Legacy fallback for pre-directory keys.
        if (id in autoAccept) {
            return autoAccept[id] === true;
        }
    }

    const directoryKey = directoryAcceptKey(directory);
    if (directoryKey in autoAccept) {
        return autoAccept[directoryKey] === true;
    }

    return false;
};

export const isDirectoryAutoAccepting = (autoAccept: PermissionAutoAcceptMap, directory: string): boolean => {
    const key = directoryAcceptKey(directory);
    return autoAccept[key] === true;
};
