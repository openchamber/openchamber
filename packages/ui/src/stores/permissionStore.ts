import { create } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import type { Session } from "@opencode-ai/sdk/v2/client";
import {
    autoRespondsPermission,
    type PermissionAutoAcceptMap,
} from "./utils/permissionAutoAccept";
import { getSafeStorage } from "./utils/safeStorage";
import { getAllSyncSessions, getSyncChildStores } from "@/sync/sync-refs";
import { opencodeClient } from "@/lib/opencode/client";
import { respondToPermission } from "@/sync/session-actions";
import { useSessionUIStore } from "@/sync/session-ui-store";

interface PermissionState {
    autoAccept: PermissionAutoAcceptMap;
}

interface PermissionActions {
    isSessionAutoAccepting: (sessionId: string) => boolean;
    setSessionAutoAccept: (sessionId: string, enabled: boolean) => Promise<void>;
}

type PermissionStore = PermissionState & PermissionActions;

const coerceAutoAcceptValue = (value: unknown): boolean => {
    if (typeof value === "boolean") {
        return value;
    }

    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true") {
            return true;
        }
        if (normalized === "false") {
            return false;
        }
    }

    if (typeof value === "number") {
        return value === 1;
    }

    return false;
};

const isLegacyDirectoryAutoAcceptKey = (key: string): boolean => key.endsWith("/*");

const extractSessionIdFromLegacyKey = (key: string): string | null => {
    const trimmed = key.trim();
    if (!trimmed) {
        return null;
    }
    const lastSlash = trimmed.lastIndexOf("/");
    if (lastSlash === -1 || lastSlash === trimmed.length - 1) {
        return trimmed;
    }
    return trimmed.slice(lastSlash + 1);
};

const resolveSessionScope = (sessionID: string, sessions: Session[]): Set<string> => {
    const map = new Map<string, Session>();
    const children = new Map<string, string[]>();
    for (const session of sessions) {
        map.set(session.id, session);
        if (session.parentID) {
            const list = children.get(session.parentID);
            if (list) {
                list.push(session.id);
            } else {
                children.set(session.parentID, [session.id]);
            }
        }
    }

    if (!map.has(sessionID)) {
        return new Set([sessionID]);
    }

    const result = new Set<string>();
    const seen = new Set<string>();
    const queue = [sessionID];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current || seen.has(current)) {
            continue;
        }
        seen.add(current);
        result.add(current);
        const nextChildren = children.get(current);
        if (!nextChildren || nextChildren.length === 0) {
            continue;
        }
        for (const child of nextChildren) {
            if (!seen.has(child)) {
                queue.push(child);
            }
        }
    }

    return result;
};

const normalizeDirectoryCandidate = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

const collectPendingFromSyncStores = (sessionScope: Set<string>): Array<{ id: string; sessionID: string }> => {
    try {
        const stores = getSyncChildStores();
        const pending: Array<{ id: string; sessionID: string }> = [];
        for (const store of stores.children.values()) {
            const permissionMap = store.getState().permission ?? {};
            for (const [sessionId, entries] of Object.entries(permissionMap)) {
                if (!sessionScope.has(sessionId)) continue;
                for (const permission of entries ?? []) {
                    if (!permission?.id) continue;
                    pending.push({ id: permission.id, sessionID: permission.sessionID || sessionId });
                }
            }
        }
        return pending;
    } catch {
        return [];
    }
};

const autoRespondsPermissionBySession = (
    autoAccept: PermissionAutoAcceptMap,
    sessions: Session[],
    sessionID: string,
): boolean => {
    return autoRespondsPermission({
        autoAccept,
        sessionID,
        sessions,
    });
};

const getStorage = () => createJSONStorage(() => getSafeStorage());

export const usePermissionStore = create<PermissionStore>()(
    devtools(
        persist(
            (set, get) => ({
                autoAccept: {},

                isSessionAutoAccepting: (sessionId: string) => {
                    if (!sessionId) {
                        return false;
                    }

                    const sessions = getAllSyncSessions();
                    return autoRespondsPermissionBySession(get().autoAccept, sessions, sessionId);
                },

                setSessionAutoAccept: async (sessionId: string, enabled: boolean) => {
                    if (!sessionId) {
                        return;
                    }

                    const sessions = getAllSyncSessions();

                    set((state) => {
                        const autoAccept = { ...state.autoAccept };
                        autoAccept[sessionId] = enabled;
                        return { autoAccept };
                    });

                    // Mirror state to the server so it can suppress permission
                    // notifications at the source (otherwise the 500ms debounce
                    // races with the client's auto-response and can leak).
                    void fetch('/api/notifications/auto-accept', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId, enabled }),
                    }).catch(() => { /* best-effort */ });

                    if (!enabled) {
                        return;
                    }

                    const sessionScope = resolveSessionScope(sessionId, sessions);
                    const sessionDirectory = useSessionUIStore.getState().getDirectoryForSession(sessionId);
                    const directories = new Set<string>();
                    const currentDirectory = normalizeDirectoryCandidate(opencodeClient.getDirectory());
                    if (currentDirectory) {
                        directories.add(currentDirectory);
                    }
                    const mappedSessionDirectory = normalizeDirectoryCandidate(sessionDirectory);
                    if (mappedSessionDirectory) {
                        directories.add(mappedSessionDirectory);
                    }
                    for (const scopedSessionId of sessionScope) {
                        const mapped = normalizeDirectoryCandidate(useSessionUIStore.getState().getDirectoryForSession(scopedSessionId));
                        if (mapped) {
                            directories.add(mapped);
                        }
                    }

                    const pendingFromStores = collectPendingFromSyncStores(sessionScope);
                    const pendingFromApi = await opencodeClient.listPendingPermissions({ directories: Array.from(directories) });
                    const mergedPending = new Map<string, { id: string; sessionID: string }>();

                    for (const permission of pendingFromStores) {
                        mergedPending.set(permission.id, permission);
                    }
                    for (const permission of pendingFromApi) {
                        if (!permission?.id || !permission?.sessionID) {
                            continue;
                        }
                        if (!sessionScope.has(permission.sessionID)) {
                            continue;
                        }
                        mergedPending.set(permission.id, { id: permission.id, sessionID: permission.sessionID });
                    }

                    await Promise.all(
                        Array.from(mergedPending.values())
                            .map((permission) => respondToPermission(permission.sessionID, permission.id, "once").catch(() => undefined)),
                    );
                },
            }),
            {
                name: "permission-store",
                storage: getStorage(),
                partialize: (state) => ({ autoAccept: state.autoAccept }),
                merge: (persistedState, currentState) => {
                    const merged = {
                        ...currentState,
                        ...(persistedState as Partial<PermissionStore>),
                    };

                    const persisted = Object.entries(merged.autoAccept || {});
                    const nextAutoAccept: PermissionAutoAcceptMap = {};

                    for (const [rawKey, rawEnabled] of persisted) {
                        if (rawKey.includes("/") || isLegacyDirectoryAutoAcceptKey(rawKey)) {
                            continue;
                        }
                        nextAutoAccept[rawKey] = coerceAutoAcceptValue(rawEnabled);
                    }

                    for (const [rawKey, rawEnabled] of persisted) {
                        if (isLegacyDirectoryAutoAcceptKey(rawKey)) {
                            continue;
                        }
                        if (!rawKey.includes("/")) {
                            continue;
                        }

                        const sessionId = extractSessionIdFromLegacyKey(rawKey);
                        if (!sessionId) {
                            continue;
                        }
                        if (Object.prototype.hasOwnProperty.call(nextAutoAccept, sessionId)) {
                            continue;
                        }

                        const normalized = coerceAutoAcceptValue(rawEnabled);
                        const existing = nextAutoAccept[sessionId];
                        nextAutoAccept[sessionId] = existing === true ? true : normalized;
                    }

                    return {
                        ...merged,
                        autoAccept: nextAutoAccept,
                    };
                },
                onRehydrateStorage: () => (state) => {
                    if (!state) return;
                    // Re-broadcast auto-accept state to the server after
                    // rehydration so server-side notification suppression
                    // survives page reloads / server restarts.
                    for (const [sid, enabled] of Object.entries(state.autoAccept || {})) {
                        if (enabled === true) {
                            void fetch('/api/notifications/auto-accept', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ sessionId: sid, enabled: true }),
                            }).catch(() => { /* best-effort */ });
                        }
                    }
                },
            }
        ),
        { name: "permission-store" }
    )
);
