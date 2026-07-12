import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Session } from "@opencode-ai/sdk/v2/client";
import { autoRespondsPermission, type PermissionAutoAcceptMap } from "./utils/permissionAutoAccept";
import { getAllSyncSessions } from "@/sync/sync-refs";
import { runtimeFetch } from "@/lib/runtime-fetch";
import { isVSCodeRuntime } from "@/lib/desktop";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
import { useSessionUIStore } from "@/sync/session-ui-store";
import { opencodeClient } from "@/lib/opencode/client";

type PermissionPolicySnapshot = {
    sessions: PermissionAutoAcceptMap;
};

interface PermissionStore {
    autoAccept: PermissionAutoAcceptMap;
    loaded: boolean;
    saving: boolean;
    hydrate: () => Promise<void>;
    applySnapshot: (snapshot: PermissionPolicySnapshot) => void;
    reset: () => void;
    isSessionAutoAccepting: (sessionId: string) => boolean;
    setSessionAutoAccept: (sessionId: string, enabled: boolean) => Promise<void>;
}

const readSnapshot = async (response: Response): Promise<PermissionPolicySnapshot> => {
    if (!response.ok) throw new Error(`Permission auto-accept request failed (${response.status})`);
    const payload = await response.json() as Partial<PermissionPolicySnapshot>;
    if (!payload.sessions || typeof payload.sessions !== "object") {
        throw new Error("Invalid permission auto-accept response");
    }
    const sessions: PermissionAutoAcceptMap = {};
    for (const [sessionId, enabled] of Object.entries(payload.sessions)) {
        if (sessionId && typeof enabled === "boolean") sessions[sessionId] = enabled;
    }
    return { sessions };
};

const requestSnapshot = async (path: string, init?: RequestInit) => readSnapshot(await runtimeFetch(path, init));

const isAutoAccepting = (autoAccept: PermissionAutoAcceptMap, sessions: Session[], sessionId: string) =>
    autoRespondsPermission({ autoAccept, sessions, sessionID: sessionId });

export const usePermissionStore = create<PermissionStore>()(persist((set, get) => ({
    autoAccept: {},
    loaded: false,
    saving: false,

    hydrate: async () => {
        let snapshot = await requestSnapshot("/api/permission-auto-accept");
        const legacyEntries = Object.entries(get().autoAccept)
            .filter(([sessionId, enabled]) => !sessionId.includes("/") && typeof enabled === "boolean");
        if (Object.keys(snapshot.sessions).length === 0 && legacyEntries.length > 0) {
            for (const [sessionId, enabled] of legacyEntries) {
                if (!sessionId || typeof enabled !== "boolean") continue;
                snapshot = await requestSnapshot(
                    `/api/permission-auto-accept/sessions/${encodeURIComponent(sessionId)}`,
                    {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ enabled }),
                    },
                );
            }
        }
        set({ autoAccept: snapshot.sessions, loaded: true });
    },

    reset: () => set({ autoAccept: {}, loaded: false, saving: false }),

    applySnapshot: (snapshot) => {
        const sessions: PermissionAutoAcceptMap = {};
        for (const [sessionId, enabled] of Object.entries(snapshot.sessions ?? {})) {
            if (sessionId && typeof enabled === "boolean") sessions[sessionId] = enabled;
        }
        set({ autoAccept: sessions, loaded: true });
    },

    isSessionAutoAccepting: (sessionId) => {
        if (!sessionId) return false;
        return isAutoAccepting(get().autoAccept, getAllSyncSessions(), sessionId);
    },

    setSessionAutoAccept: async (sessionId, enabled) => {
        if (!sessionId) return;
        if (isVSCodeRuntime()) {
            const response = await runtimeFetch("/api/notifications/auto-accept", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionId, enabled }),
            });
            if (!response.ok) throw new Error(`Permission auto-accept request failed (${response.status})`);
            set((state) => ({ autoAccept: { ...state.autoAccept, [sessionId]: enabled }, loaded: true }));
            return;
        }
        set({ saving: true });
        try {
            const directory = useSessionUIStore.getState().getDirectoryForSession(sessionId)
                ?? opencodeClient.getDirectory()
                ?? undefined;
            const snapshot = await requestSnapshot(
                `/api/permission-auto-accept/sessions/${encodeURIComponent(sessionId)}`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ enabled, directory }),
                },
            );
            set({ autoAccept: snapshot.sessions, loaded: true });
        } finally {
            set({ saving: false });
        }
    },

}), {
    name: "permission-store",
    storage: createDeferredSafeJSONStorage(),
    partialize: (state) => ({ autoAccept: state.autoAccept }),
}));
