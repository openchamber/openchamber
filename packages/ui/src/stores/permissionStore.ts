import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Session } from "@opencode-ai/sdk/v2/client";
import { autoRespondsPermission, type PermissionAutoAcceptMap } from "./utils/permissionAutoAccept";
import { getAllSyncSessionMap } from "@/sync/sync-refs";
import { runtimeFetch } from "@/lib/runtime-fetch";
import { isVSCodeRuntime } from "@/lib/desktop";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
import { useSessionUIStore } from "@/sync/session-ui-store";
import { opencodeClient } from "@/lib/opencode/client";
import { getRuntimeApiBaseUrl, getRuntimeKey, subscribeRuntimeEndpointChanged, type RuntimeEndpointChangedDetail } from "@/lib/runtime-switch";

type PermissionPolicySnapshot = {
    default: boolean;
    sessions: PermissionAutoAcceptMap;
};

interface PermissionStore {
    defaultEnabled: boolean;
    autoAccept: PermissionAutoAcceptMap;
    loaded: boolean;
    saving: boolean;
    hydrate: () => Promise<void>;
    applySnapshot: (snapshot: PermissionPolicySnapshot) => void;
    reset: () => void;
    isSessionAutoAccepting: (sessionId: string) => boolean;
    setDefaultAutoAccept: (enabled: boolean) => Promise<void>;
    setSessionAutoAccept: (sessionId: string, enabled: boolean) => Promise<void>;
}

type PermissionStoreDependencies = {
    isVSCodeRuntime: () => boolean;
    reconcileVSCodePendingPermissions: (directory?: string) => Promise<void>;
};

type PermissionRuntimeContext = {
    runtimeKey: string;
    apiIdentity: string;
    generation: number;
};

let _permissionRuntimeGeneration = 0;
let _permissionRuntimeLifecycleInitialized = false;

const defaultPermissionStoreDependencies: PermissionStoreDependencies = {
    isVSCodeRuntime,
    reconcileVSCodePendingPermissions: async (directory?: string) => {
        const { reconcileVSCodePendingPermissions } = await import("@/sync/vscode-permission-auto-accept");
        await reconcileVSCodePendingPermissions(directory);
    },
};

let permissionStoreDependencies: PermissionStoreDependencies = { ...defaultPermissionStoreDependencies };

export const setPermissionStoreTestDependencies = (
    overrides?: Partial<PermissionStoreDependencies>,
): void => {
    permissionStoreDependencies = {
        ...defaultPermissionStoreDependencies,
        ...(overrides ?? {}),
    };
};

const getPermissionRuntimeApiIdentity = (): string => {
    const apiBaseUrl = getRuntimeApiBaseUrl().trim();
    return apiBaseUrl || "same-origin";
};

const capturePermissionRuntimeContext = (): PermissionRuntimeContext => ({
    runtimeKey: getRuntimeKey(),
    apiIdentity: getPermissionRuntimeApiIdentity(),
    generation: _permissionRuntimeGeneration,
});

const isPermissionRuntimeContextCurrent = (context: PermissionRuntimeContext): boolean => (
    context.generation === _permissionRuntimeGeneration
    && context.runtimeKey === getRuntimeKey()
    && context.apiIdentity === getPermissionRuntimeApiIdentity()
);

const resetPermissionStoreForRuntimeSwitch = (): void => {
    usePermissionStore.setState({ defaultEnabled: false, autoAccept: {}, loaded: false, saving: false });
};

const ensurePermissionRuntimeLifecycle = (): void => {
    if (_permissionRuntimeLifecycleInitialized || typeof window === "undefined") {
        return;
    }
    _permissionRuntimeLifecycleInitialized = true;
    subscribeRuntimeEndpointChanged((detail: RuntimeEndpointChangedDetail) => {
        if (detail.runtimeKey === detail.previousRuntimeKey && detail.apiBaseUrl === detail.previousApiBaseUrl) {
            return;
        }
        _permissionRuntimeGeneration += 1;
        resetPermissionStoreForRuntimeSwitch();
    });
};

const readSnapshot = async (response: Response): Promise<PermissionPolicySnapshot> => {
    if (!response.ok) throw new Error(`Permission auto-accept request failed (${response.status})`);
    const payload = await response.json() as Partial<PermissionPolicySnapshot>;
    if (!payload.sessions || typeof payload.sessions !== "object") {
        throw new Error("Invalid permission auto-accept response");
    }
    const defaultEnabled = payload.default === true;
    const sessions: PermissionAutoAcceptMap = {};
    for (const [sessionId, enabled] of Object.entries(payload.sessions)) {
        if (sessionId && typeof enabled === "boolean") sessions[sessionId] = enabled;
    }
    return { default: defaultEnabled, sessions };
};

const requestSnapshot = async (path: string, init?: RequestInit) => readSnapshot(await runtimeFetch(path, init));

const isAutoAccepting = (
    defaultEnabled: boolean,
    autoAccept: PermissionAutoAcceptMap,
    sessionById: ReadonlyMap<string, Session>,
    sessionId: string,
) => autoRespondsPermission({ defaultEnabled, autoAccept, sessions: [], sessionById, sessionID: sessionId });

export const usePermissionStore = create<PermissionStore>()(persist((set, get) => ({
    defaultEnabled: false,
    autoAccept: {},
    loaded: false,
    saving: false,

    hydrate: async () => {
        ensurePermissionRuntimeLifecycle();
        const context = capturePermissionRuntimeContext();
        if (!isPermissionRuntimeContextCurrent(context)) {
            return;
        }
        let snapshot = await requestSnapshot("/api/permission-auto-accept");
        if (!isPermissionRuntimeContextCurrent(context)) {
            return;
        }
        const legacyEntries = Object.entries(get().autoAccept)
            .filter(([sessionId, enabled]) => !sessionId.includes("/") && typeof enabled === "boolean");
        if (Object.keys(snapshot.sessions).length === 0 && legacyEntries.length > 0) {
            for (const [sessionId, enabled] of legacyEntries) {
                if (!sessionId || typeof enabled !== "boolean") continue;
                if (!isPermissionRuntimeContextCurrent(context)) {
                    return;
                }
                snapshot = await requestSnapshot(
                    `/api/permission-auto-accept/sessions/${encodeURIComponent(sessionId)}`,
                    {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ enabled }),
                    },
                );
                if (!isPermissionRuntimeContextCurrent(context)) {
                    return;
                }
            }
        }
        if (!isPermissionRuntimeContextCurrent(context)) {
            return;
        }
        set({ defaultEnabled: snapshot.default, autoAccept: snapshot.sessions, loaded: true });
    },

    reset: () => set({ defaultEnabled: false, autoAccept: {}, loaded: false, saving: false }),

    applySnapshot: (snapshot) => {
        const sessions: PermissionAutoAcceptMap = {};
        for (const [sessionId, enabled] of Object.entries(snapshot.sessions ?? {})) {
            if (sessionId && typeof enabled === "boolean") sessions[sessionId] = enabled;
        }
        set({ defaultEnabled: snapshot.default === true, autoAccept: sessions, loaded: true });
    },

    isSessionAutoAccepting: (sessionId) => {
        if (!sessionId) return false;
        if (!get().loaded) return false;
        const autoAccept = get().autoAccept;
        const defaultEnabled = get().defaultEnabled;
        if (!defaultEnabled && Object.keys(autoAccept).length === 0) return false;
        return isAutoAccepting(defaultEnabled, autoAccept, getAllSyncSessionMap(), sessionId);
    },

    setDefaultAutoAccept: async (enabled) => {
        ensurePermissionRuntimeLifecycle();
        const context = capturePermissionRuntimeContext();
        set({ saving: true });
        try {
            const snapshot = await requestSnapshot(
                "/api/permission-auto-accept/default",
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ enabled }),
                },
            );
            if (!isPermissionRuntimeContextCurrent(context)) {
                return;
            }
            set({ defaultEnabled: snapshot.default, autoAccept: snapshot.sessions, loaded: true });
            if (permissionStoreDependencies.isVSCodeRuntime() && enabled) {
                void permissionStoreDependencies.reconcileVSCodePendingPermissions().catch(() => undefined);
            }
        } finally {
            if (isPermissionRuntimeContextCurrent(context)) {
                set({ saving: false });
            }
        }
    },

    setSessionAutoAccept: async (sessionId, enabled) => {
        if (!sessionId) return;
        ensurePermissionRuntimeLifecycle();
        const context = capturePermissionRuntimeContext();
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
            if (!isPermissionRuntimeContextCurrent(context)) {
                return;
            }
            set({ defaultEnabled: snapshot.default, autoAccept: snapshot.sessions, loaded: true });
            if (permissionStoreDependencies.isVSCodeRuntime() && enabled) {
                void permissionStoreDependencies.reconcileVSCodePendingPermissions(directory).catch(() => undefined);
            }
        } finally {
            if (isPermissionRuntimeContextCurrent(context)) {
                set({ saving: false });
            }
        }
    },

}), {
    name: "permission-store",
    storage: createDeferredSafeJSONStorage(),
    partialize: (state) => ({ autoAccept: state.autoAccept }),
}));
