import { create } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import { getSafeStorage } from "./utils/safeStorage";
import type { Session } from "@opencode-ai/sdk/v2/client";
import {
    getPermissionLevel,
    isAutoAcceptingLevel,
    normalizeDirectory,
    resolvePermissionLevel,
    sessionAcceptKey,
    type PermissionAutoAcceptMap,
    type PermissionLevel,
} from "./utils/permissionAutoAccept";
import { getAllSyncSessions } from "@/sync/sync-refs";
import { opencodeClient } from "@/lib/opencode/client";
import { useSessionUIStore } from "@/sync/session-ui-store";

interface PermissionState {
    autoAccept: PermissionAutoAcceptMap;
}

interface PermissionActions {
    isSessionAutoAccepting: (sessionId: string) => boolean;
    getSessionPermissionLevel: (sessionId: string) => PermissionLevel;
    setSessionAutoAccept: (sessionId: string, enabled: boolean) => Promise<void>;
    setSessionPermissionLevel: (sessionId: string, level: PermissionLevel) => Promise<void>;
}

type PermissionStore = PermissionState & PermissionActions;

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

const resolveSessionDirectory = (sessionID: string, sessions: Session[]): string | null => {
    const targetSession = sessions.find((session) => session.id === sessionID);
    const mappedDirectory = useSessionUIStore.getState().getDirectoryForSession(sessionID);
    return normalizeDirectory(mappedDirectory ?? (targetSession as Session & { directory?: string | null })?.directory ?? null);
};

const getPermissionLevelBySession = (
    autoAccept: PermissionAutoAcceptMap,
    sessions: Session[],
    sessionID: string,
): PermissionLevel => {
    const directory = resolveSessionDirectory(sessionID, sessions);
    if (!directory) {
        for (const id of resolveLineage(sessionID, sessions)) {
            if (id in autoAccept) {
                return resolvePermissionLevel(autoAccept[id]);
            }
        }
        return 'manual';
    }

    return getPermissionLevel({
        autoAccept,
        sessions,
        sessionID,
        directory,
    });
};

const autoRespondsPermissionBySession = (
    autoAccept: PermissionAutoAcceptMap,
    sessions: Session[],
    sessionID: string,
): boolean => {
    return isAutoAcceptingLevel(getPermissionLevelBySession(autoAccept, sessions, sessionID));
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

                getSessionPermissionLevel: (sessionId: string): PermissionLevel => {
                    if (!sessionId) {
                        return 'manual';
                    }

                    const sessions = getAllSyncSessions();
                    return getPermissionLevelBySession(get().autoAccept, sessions, sessionId);
                },

                setSessionPermissionLevel: async (sessionId: string, level: PermissionLevel) => {
                    if (!sessionId) {
                        return;
                    }

                    const sessions = getAllSyncSessions();
                    const targetSession = sessions.find((session) => session.id === sessionId);
                    const mappedDirectory = useSessionUIStore.getState().getDirectoryForSession(sessionId);
                    const directory = normalizeDirectory(mappedDirectory ?? (targetSession as Session & { directory?: string | null })?.directory ?? null);
                    const key = directory ? sessionAcceptKey(sessionId, directory) : sessionId;

                    set((state) => {
                        const autoAccept = { ...state.autoAccept };
                        if (directory) {
                            delete autoAccept[sessionId];
                        }
                        autoAccept[key] = level;
                        return { autoAccept };
                    });

                    if (!isAutoAcceptingLevel(level) || !directory) {
                        return;
                    }

                    const pending = await opencodeClient.listPendingPermissions({ directories: [directory] });
                    const client = opencodeClient.getScopedSdkClient(directory);
                    const sessionLineage = new Set(resolveLineage(sessionId, sessions));
                    await Promise.all(
                        pending
                            .filter((permission) => sessionLineage.has(permission.sessionID))
                            .map((permission) => client.permission.reply({ requestID: permission.id, reply: "once" }).catch(() => undefined)),
                    );
                },

                setSessionAutoAccept: async (sessionId: string, enabled: boolean) => {
                    if (!sessionId) {
                        return;
                    }

                    const sessions = getAllSyncSessions();
                    const targetSession = sessions.find((session) => session.id === sessionId);
                    const mappedDirectory = useSessionUIStore.getState().getDirectoryForSession(sessionId);
                    const directory = normalizeDirectory(mappedDirectory ?? (targetSession as Session & { directory?: string | null })?.directory ?? null);
                    const key = directory ? sessionAcceptKey(sessionId, directory) : sessionId;

                    set((state) => {
                        const autoAccept = { ...state.autoAccept };
                        if (directory) {
                            delete autoAccept[sessionId];
                        }
                        autoAccept[key] = enabled;
                        return { autoAccept };
                    });

                    if (!enabled || !directory) {
                        return;
                    }

                    const pending = await opencodeClient.listPendingPermissions({ directories: [directory] });
                    const client = opencodeClient.getScopedSdkClient(directory);
                    const sessionLineage = new Set(resolveLineage(sessionId, sessions));
                    await Promise.all(
                        pending
                            .filter((permission) => sessionLineage.has(permission.sessionID))
                            .map((permission) => client.permission.reply({ requestID: permission.id, reply: "once" }).catch(() => undefined)),
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

                    const nextAutoAccept = Object.fromEntries(
                        Object.entries(merged.autoAccept || {}).map(([sessionId, value]) => [
                            sessionId,
                            resolvePermissionLevel(value as boolean | PermissionLevel),
                        ]),
                    );

                    return {
                        ...merged,
                        autoAccept: nextAutoAccept,
                    };
                },
            }
        ),
        { name: "permission-store" }
    )
);
