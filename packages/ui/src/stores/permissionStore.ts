import { create } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import type { Session } from "@opencode-ai/sdk/v2/client";
import {
    autoRespondsPermission,
    normalizeDirectory,
    sessionAcceptKey,
    type PermissionAutoAcceptMap,
} from "./utils/permissionAutoAccept";
import { getSafeStorage } from "./utils/safeStorage";
import { getAllSyncSessions } from "@/sync/sync-refs";
import { opencodeClient } from "@/lib/opencode/client";
import { useSessionUIStore } from "@/sync/session-ui-store";

interface PermissionState {
    autoAccept: PermissionAutoAcceptMap;
}

interface PermissionActions {
    isSessionAutoAccepting: (sessionId: string) => boolean;
    setSessionAutoAccept: (sessionId: string, enabled: boolean) => Promise<void>;
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

const autoRespondsPermissionBySession = (
    autoAccept: PermissionAutoAcceptMap,
    sessions: Session[],
    sessionID: string,
): boolean => {
    const targetSession = sessions.find((session) => session.id === sessionID);
    const mappedDirectory = useSessionUIStore.getState().getDirectoryForSession(sessionID);
    const directory = normalizeDirectory(mappedDirectory ?? (targetSession as Session & { directory?: string | null })?.directory ?? null);
    if (!directory) {
        for (const id of resolveLineage(sessionID, sessions)) {
            if (id in autoAccept) {
                return autoAccept[id] === true;
            }
        }
        return false;
    }

    return autoRespondsPermission({
        autoAccept,
        sessions,
        sessionID,
        directory,
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
                        Object.entries(merged.autoAccept || {}).map(([sessionId, enabled]) => [
                            sessionId,
                            Boolean(enabled),
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
