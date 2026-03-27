import { create } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import { opencodeClient } from "@/lib/opencode/client";
import type { Session } from "@opencode-ai/sdk/v2/client";
import type { PermissionRequest, PermissionResponse } from "@/types/permission";
import {
    normalizeDirectory,
    type PermissionAutoAcceptMap,
} from "./utils/permissionAutoAccept";
import { getSafeStorage } from "./utils/safeStorage";
import { useMessageStore } from "./messageStore";
import { useSessionStore } from "./sessionStore";

interface PermissionState {
    permissions: Map<string, PermissionRequest[]>;
    autoAccept: PermissionAutoAcceptMap;
}

interface PermissionActions {
    addPermission: (permission: PermissionRequest) => void;
    respondToPermission: (sessionId: string, requestId: string, response: PermissionResponse) => Promise<void>;
    dismissPermission: (sessionId: string, requestId: string) => void;
    isSessionAutoAccepting: (sessionId: string) => boolean;
    setSessionAutoAccept: (sessionId: string, enabled: boolean) => Promise<void>;
}

type PermissionStore = PermissionState & PermissionActions;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const sanitizePermissionEntries = (value: unknown): Array<[string, PermissionRequest[]]> => {
    if (!Array.isArray(value)) {
        return [];
    }
    const entries: Array<[string, PermissionRequest[]]> = [];
    value.forEach((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) {
            return;
        }
        const [sessionId, permissions] = entry;
        if (typeof sessionId !== "string" || !Array.isArray(permissions)) {
            return;
        }
        entries.push([sessionId, permissions as PermissionRequest[]]);
    });
    return entries;
};

const executeWithPermissionDirectory = async <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
    try {
        const sessionStore = useSessionStore.getState();
        const directory = sessionStore.getDirectoryForSession(sessionId);
        if (directory) {
            return opencodeClient.withDirectory(directory, operation);
        }
    } catch (error) {
        console.warn('Failed to resolve session directory for permission handling:', error);
    }
    return operation();
};

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

const autoRespondsPermissionBySession = (
    autoAccept: PermissionAutoAcceptMap,
    sessions: Session[],
    sessionID: string,
): boolean => {
    for (const id of resolveLineage(sessionID, sessions)) {
        if (id in autoAccept) {
            return autoAccept[id] === true;
        }
    }
    return false;
};

const shouldAutoRespond = (permission: PermissionRequest, autoAccept: PermissionAutoAcceptMap): boolean => {
    if (!permission?.sessionID) {
        return false;
    }

    const sessionStore = useSessionStore.getState();
    const sessions = sessionStore.sessions;
    return autoRespondsPermissionBySession(
        autoAccept,
        sessions,
        permission.sessionID,
    );
};

const collectPermissionDirectories = (fallbackDirectory?: string | null): string[] => {
    const sessionStore = useSessionStore.getState();
    const dirs = new Set<string>();
    const fallback = normalizeDirectory(fallbackDirectory);
    if (fallback) {
        dirs.add(fallback);
    }

    const currentDirectory = normalizeDirectory(opencodeClient.getDirectory());
    if (currentDirectory) {
        dirs.add(currentDirectory);
    }

    for (const session of sessionStore.sessions) {
        const normalized = normalizeDirectory((session as { directory?: string | null }).directory);
        if (normalized) {
            dirs.add(normalized);
        }
    }

    return Array.from(dirs);
};

const reconcilePendingAutoAccept = async (
    autoAccept: PermissionAutoAcceptMap,
    fallbackDirectory?: string | null,
) => {
    const directories = collectPermissionDirectories(fallbackDirectory);
    if (directories.length === 0) {
        return;
    }

    const pending = await opencodeClient.listPendingPermissions({ directories });
    if (pending.length === 0) {
        return;
    }

    for (const request of pending) {
        if (!request?.sessionID || !request?.id) {
            continue;
        }
        if (!shouldAutoRespond(request, autoAccept)) {
            continue;
        }
        try {
            await executeWithPermissionDirectory(request.sessionID, () => opencodeClient.replyToPermission(request.id, 'once'));
        } catch {
            // ignored
        }
    }
};

export const usePermissionStore = create<PermissionStore>()(
    devtools(
        persist(
            (set, get) => ({

                permissions: new Map(),
                autoAccept: {},

                addPermission: (permission: PermissionRequest) => {
                    const sessionId = permission.sessionID;
                    if (!sessionId) {
                        return;
                    }

                    const existing = get().permissions.get(sessionId);
                    if (existing?.some((entry) => entry.id === permission.id)) {
                        return;
                    }

                    if (shouldAutoRespond(permission, get().autoAccept)) {
                        get().respondToPermission(sessionId, permission.id, 'once').catch(() => {

                        });
                        return;
                    }

                    set((state) => {
                        const sessionPermissions = state.permissions.get(sessionId) || [];
                        const newPermissions = new Map(state.permissions);
                        newPermissions.set(sessionId, [...sessionPermissions, permission]);
                        return { permissions: newPermissions };
                    });
                },

                respondToPermission: async (sessionId: string, requestId: string, response: PermissionResponse) => {
                    await executeWithPermissionDirectory(sessionId, () => opencodeClient.replyToPermission(requestId, response));

                    if (response === 'reject') {
                        const messageStore = useMessageStore.getState();

                        await messageStore.abortCurrentOperation(sessionId);
                    }

                    set((state) => {
                        const sessionPermissions = state.permissions.get(sessionId) || [];
                        const updatedPermissions = sessionPermissions.filter((p) => p.id !== requestId);
                        const newPermissions = new Map(state.permissions);
                        newPermissions.set(sessionId, updatedPermissions);
                        return { permissions: newPermissions };
                    });
                },

                dismissPermission: (sessionId: string, requestId: string) => {
                    set((state) => {
                        const sessionPermissions = state.permissions.get(sessionId) || [];
                        const updatedPermissions = sessionPermissions.filter((p) => p.id !== requestId);
                        const newPermissions = new Map(state.permissions);
                        newPermissions.set(sessionId, updatedPermissions);
                        return { permissions: newPermissions };
                    });
                },

                isSessionAutoAccepting: (sessionId: string) => {
                    if (!sessionId) {
                        return false;
                    }

                    const sessions = useSessionStore.getState().sessions;
                    return autoRespondsPermissionBySession(get().autoAccept, sessions, sessionId);
                },

                setSessionAutoAccept: async (sessionId: string, enabled: boolean) => {
                    if (!sessionId) {
                        return;
                    }

                    set((state) => ({
                        autoAccept: {
                            ...state.autoAccept,
                            [sessionId]: enabled,
                        },
                    }));

                    if (!enabled) {
                        return;
                    }
                    const sessionDirectory = useSessionStore.getState().getDirectoryForSession(sessionId);
                    void reconcilePendingAutoAccept(get().autoAccept, sessionDirectory);
                },
            }),
            {
                name: "permission-store",
                storage: createJSONStorage(() => getSafeStorage()),
                partialize: (state) => ({
                    permissions: Array.from(state.permissions.entries()),
                    autoAccept: state.autoAccept,
                }),
                merge: (persistedState, currentState) => {
                    if (!isRecord(persistedState)) {
                        return currentState;
                    }
                    const entries = sanitizePermissionEntries(persistedState.permissions);
                    const autoAccept = isRecord(persistedState.autoAccept)
                        ? Object.fromEntries(
                            Object.entries(persistedState.autoAccept).filter((entry): entry is [string, boolean] => {
                                return typeof entry[0] === "string" && typeof entry[1] === "boolean";
                            }),
                        )
                        : {};
                    return {
                        ...currentState,
                        permissions: new Map(entries),
                        autoAccept,
                    };
                },
            }
        ),
        {
            name: "permission-store",
        }
    )
);
