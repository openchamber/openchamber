import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import type { Session } from "@/lib/opencode/model";
import {
    permissionPolicyWireSchema,
    policySnapshotFromWire,
    resolvePermissionMode,
    type PermissionMode,
    type PermissionModeMap,
    type PermissionPolicySnapshot,
} from "./utils/permissionAutoAccept";
import { getAllSyncSessionMap } from "@/sync/sync-refs";
import { runtimeFetch, type RuntimeFetchOptions } from "@/lib/runtime-fetch";
import { spaceIdOfDirectory } from "@/lib/spaces/space-route";
import { isVSCodeRuntime } from "@/lib/desktop";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
import { useSessionUIStore } from "@/sync/session-ui-store";
import { opencodeClient } from "@/lib/opencode/client";
import { getRuntimeKey } from "@/lib/runtime-switch";

interface PermissionStore {
    /** The host's policy: every session that is not in an isolated space. */
    modes: PermissionModeMap;
    /**
     * Each isolated space's own policy, by space id: the server inside the space keeps the modes
     * of its sessions and answers their requests, so it is read and written there.
     */
    spaceModes: Readonly<Record<string, PermissionModeMap>>;
    loaded: boolean;
    saving: boolean;
    lastAppliedRevision: number;
    legacyCandidate: Record<string, boolean> | null;
    legacyRuntimeKey: string | null;
    hydrate: () => Promise<void>;
    /** Applies a policy from its owner: the host (`''`, the default) or the space with that id. */
    applySnapshot: (snapshot: PermissionPolicySnapshot, expectedRuntimeKey?: string, owner?: string) => void;
    /** Reads one isolated space's policy from that space; a space that cannot be read keeps what was known. */
    refreshSpaceModes: (spaceId: string) => Promise<boolean>;
    reset: () => void;
    getSessionMode: (sessionId: string) => PermissionMode;
    setSessionMode: (sessionId: string, mode: PermissionMode) => Promise<void>;
}

const readSnapshot = async (response: Response): Promise<PermissionPolicySnapshot> => {
    if (!response.ok) throw new Error(`Permission auto-accept request failed (${response.status})`);
    const parsed = permissionPolicyWireSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Invalid permission auto-accept response");
    return policySnapshotFromWire(parsed.data);
};

const requestSnapshot = async (path: string, init?: RuntimeFetchOptions) => readSnapshot(await runtimeFetch(path, init));

// `enabled` rides along for servers from before the modes and for VS Code's
// bridge, which know only on/off. The directory also picks the server: a
// space's session has its mode in that space.
const putSessionMode = (sessionId: string, mode: PermissionMode, directory?: string) => requestSnapshot(
    `/api/permission-auto-accept/sessions/${encodeURIComponent(sessionId)}`,
    {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, enabled: mode !== "ask", directory }),
        directory: directory ?? null,
    },
);

/** The owner of a session's mode: the space its directory lies in, or the host (''). */
const modeOwnerOf = (directory: string | null | undefined): string => spaceIdOfDirectory(directory) ?? "";

/** A session's directory, as the sync layer knows it, else as the session store resolves it. */
const sessionDirectoryOf = (sessionId: string, sessionById: ReadonlyMap<string, Session>): string | null => (
    sessionById.get(sessionId)?.directory ?? useSessionUIStore.getState().getDirectoryForSession(sessionId)
);

/** Revisions of each space's policy, which numbers its own, per runtime. */
const spaceRevisions = new Map<string, number>();
const spaceRevisionKey = (runtimeKey: string, spaceId: string) => `${runtimeKey}\n${spaceId}`;

const modeOf = (modes: PermissionModeMap, sessionById: ReadonlyMap<string, Session>, sessionId: string) =>
    resolvePermissionMode({ modes, sessions: [], sessionById, sessionID: sessionId });

type PermissionOperation = { generation: number; runtimeKey: string; sequence: number };
let generation = 0;
let operationSequence = 0;
let latestStartedSequence = 0;
const pendingSavingOperations = new Set<number>();

const beginOperation = (): PermissionOperation => {
    const operation = { generation, runtimeKey: getRuntimeKey(), sequence: ++operationSequence };
    latestStartedSequence = operation.sequence;
    return operation;
};

const isCurrentOperation = (operation: PermissionOperation) => (
    operation.generation === generation && operation.runtimeKey === getRuntimeKey()
);

const legacySessionsSchema = z.record(z.string().min(1), z.boolean());

/** Version 1 kept the policy itself in localStorage as an on/off map. */
const persistedV1Schema = z.object({
    autoAccept: legacySessionsSchema.catch({}).default({}),
}).catch({ autoAccept: {} });

/** Version 2 keeps only a not-yet-migrated version 1 policy. */
const persistedV2Schema = z.object({
    legacyCandidate: legacySessionsSchema.nullable().catch(null).default(null),
    legacyRuntimeKey: z.string().nullable().catch(null).default(null),
}).catch({ legacyCandidate: null, legacyRuntimeKey: null });

export const usePermissionStore = create<PermissionStore>()(persist((set, get) => ({
    modes: {},
    spaceModes: {},
    loaded: false,
    saving: false,
    lastAppliedRevision: -1,
    legacyCandidate: null,
    legacyRuntimeKey: null,

    hydrate: async () => {
        const operation = beginOperation();
        const legacyCandidate = get().legacyCandidate;
        let legacyRuntimeKey = get().legacyRuntimeKey;
        if (legacyCandidate && !legacyRuntimeKey) {
            legacyRuntimeKey = operation.runtimeKey;
            set({ legacyRuntimeKey });
        }
        let snapshot = await requestSnapshot("/api/permission-auto-accept");
        if (!isCurrentOperation(operation)) return;
        const legacyEntries = legacyRuntimeKey === operation.runtimeKey
            ? Object.entries(legacyCandidate ?? {})
            : [];
        if (Object.keys(snapshot.modes).length === 0 && legacyEntries.length > 0) {
            for (const [sessionId, enabled] of legacyEntries) {
                if (!sessionId) continue;
                snapshot = await putSessionMode(sessionId, enabled ? "auto" : "ask");
                if (!isCurrentOperation(operation)) return;
            }
        }
        if (!isCurrentOperation(operation)) return;
        if (snapshot.revision === undefined && operation.sequence !== latestStartedSequence) return;
        get().applySnapshot(snapshot, operation.runtimeKey);
        if (legacyRuntimeKey === operation.runtimeKey) {
            set({ legacyCandidate: null, legacyRuntimeKey: null });
        }
    },

    reset: () => {
        generation += 1;
        latestStartedSequence = 0;
        pendingSavingOperations.clear();
        spaceRevisions.clear();
        set({ modes: {}, spaceModes: {}, loaded: false, saving: false, lastAppliedRevision: -1 });
    },

    applySnapshot: (snapshot, expectedRuntimeKey, owner = "") => {
        if (expectedRuntimeKey && expectedRuntimeKey !== getRuntimeKey()) return;
        const { revision } = snapshot;
        if (owner) {
            const key = spaceRevisionKey(expectedRuntimeKey ?? getRuntimeKey(), owner);
            if (revision !== undefined) {
                if (revision < (spaceRevisions.get(key) ?? -1)) return;
                spaceRevisions.set(key, revision);
            }
            set((state) => ({ spaceModes: { ...state.spaceModes, [owner]: snapshot.modes } }));
            return;
        }
        set((state) => {
            if (revision === undefined) {
                return state.lastAppliedRevision >= 0 ? state : { modes: snapshot.modes, loaded: true };
            }
            if (revision < state.lastAppliedRevision) return state;
            return { modes: snapshot.modes, loaded: true, lastAppliedRevision: revision };
        });
    },

    refreshSpaceModes: async (spaceId) => {
        const runtimeKey = getRuntimeKey();
        let snapshot: PermissionPolicySnapshot;
        try {
            snapshot = await requestSnapshot("/api/permission-auto-accept", { directory: `/spaces/${spaceId}` });
        } catch {
            return false;
        }
        get().applySnapshot(snapshot, runtimeKey, spaceId);
        return true;
    },

    getSessionMode: (sessionId) => {
        if (!sessionId) return "ask";
        const sessionById = getAllSyncSessionMap();
        const owner = modeOwnerOf(sessionDirectoryOf(sessionId, sessionById));
        const modes = owner ? get().spaceModes[owner] ?? {} : get().modes;
        if (Object.keys(modes).length === 0) return "ask";
        return modeOf(modes, sessionById, sessionId);
    },

    setSessionMode: async (sessionId, mode) => {
        if (!sessionId) return;
        const operation = beginOperation();
        pendingSavingOperations.add(operation.sequence);
        set({ saving: true });
        try {
            const directory = sessionDirectoryOf(sessionId, getAllSyncSessionMap())
                ?? opencodeClient.getDirectory()
                ?? undefined;
            const snapshot = await putSessionMode(sessionId, mode, directory);
            if (!isCurrentOperation(operation)) return;
            if (snapshot.revision === undefined && operation.sequence !== latestStartedSequence) return;
            get().applySnapshot(snapshot, operation.runtimeKey, modeOwnerOf(directory));
            if (isCurrentOperation(operation) && isVSCodeRuntime() && mode !== "ask") {
                const { reconcileVSCodePendingPermissions } = await import("@/sync/vscode-permission-auto-accept");
                if (isCurrentOperation(operation)) {
                    void reconcileVSCodePendingPermissions(directory).catch(() => undefined);
                }
            }
        } finally {
            if (isCurrentOperation(operation)) {
                pendingSavingOperations.delete(operation.sequence);
                set({ saving: pendingSavingOperations.size > 0 });
            }
        }
    },

}), {
    name: "permission-store",
    storage: createDeferredSafeJSONStorage(),
    version: 2,
    migrate: (persisted, version) => {
        if (version < 2) {
            const legacyCandidate = persistedV1Schema.parse(persisted ?? {}).autoAccept;
            return {
                legacyCandidate: Object.keys(legacyCandidate).length > 0 ? legacyCandidate : null,
                legacyRuntimeKey: null,
            };
        }
        return persistedV2Schema.parse(persisted ?? {});
    },
    partialize: (state) => ({
        legacyCandidate: state.legacyCandidate,
        legacyRuntimeKey: state.legacyRuntimeKey,
    }),
}));
