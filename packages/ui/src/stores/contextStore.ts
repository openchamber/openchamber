/* oxlint-disable typescript/no-explicit-any */
import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { EditPermissionMode } from "./types/sessionTypes";
import { getAgentDefaultEditPermission } from "./utils/permissionUtils";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";

interface ContextState {

    sessionModelSelections: Map<string, { providerId: string; modelId: string }>;
    sessionAgentSelections: Map<string, string>;

    sessionAgentModelSelections: Map<string, Map<string, { providerId: string; modelId: string }>>;

    sessionAgentModelVariantSelections: Map<string, Map<string, Map<string, string | null>>>;
 
    currentAgentContext: Map<string, string>;

    sessionAgentEditModes: Map<string, Map<string, EditPermissionMode>>;
    hasHydrated: boolean;
}

interface ContextActions {

    saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => void;
    getSessionModelSelection: (sessionId: string) => { providerId: string; modelId: string } | null;
    saveSessionAgentSelection: (sessionId: string, agentName: string) => void;
    getSessionAgentSelection: (sessionId: string) => string | null;

    saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => void;
    getAgentModelForSession: (sessionId: string, agentName: string) => { providerId: string; modelId: string } | null;

    saveAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string, variant: string | null | undefined) => void;
    getAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => string | null | undefined;

    getCurrentAgent: (sessionId: string) => string | undefined;

    getSessionAgentEditMode: (sessionId: string, agentName: string | undefined, defaultMode?: EditPermissionMode) => EditPermissionMode;
    toggleSessionAgentEditMode: (sessionId: string, agentName: string | undefined, defaultMode?: EditPermissionMode) => void;
    setSessionAgentEditMode: (sessionId: string, agentName: string | undefined, mode: EditPermissionMode, defaultMode?: EditPermissionMode) => void;
}

type ContextStore = ContextState & ContextActions;

const EDIT_PERMISSION_SEQUENCE: EditPermissionMode[] = ['ask', 'allow', 'full'];
const GLOBAL_EDIT_MODE_SESSION_ID = '__global__';

export const useContextStore = create<ContextStore>()(
    devtools(
        persist(
            (set, get) => ({

                sessionModelSelections: new Map(),
                sessionAgentSelections: new Map(),
                sessionAgentModelSelections: new Map(),
                sessionAgentModelVariantSelections: new Map(),
                currentAgentContext: new Map(),
                sessionAgentEditModes: new Map(),
                hasHydrated: typeof window === "undefined",

                saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => {
                    set((state) => {
                        const newSelections = new Map(state.sessionModelSelections);
                        newSelections.set(sessionId, { providerId, modelId });
                        return { sessionModelSelections: newSelections };
                    });
                },

                getSessionModelSelection: (sessionId: string) => {
                    const { sessionModelSelections } = get();
                    return sessionModelSelections.get(sessionId) || null;
                },

                saveSessionAgentSelection: (sessionId: string, agentName: string) => {
                    set((state) => {
                        const newSelections = new Map(state.sessionAgentSelections);
                        newSelections.set(sessionId, agentName);

                        const nextAgentContext = new Map(state.currentAgentContext);
                        nextAgentContext.set(sessionId, agentName);

                        return {
                            sessionAgentSelections: newSelections,
                            currentAgentContext: nextAgentContext,
                        };
                    });
                },

                getSessionAgentSelection: (sessionId: string) => {
                    const { sessionAgentSelections } = get();
                    return sessionAgentSelections.get(sessionId) || null;
                },

                saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => {
                    set((state) => {
                        const newSelections = new Map(state.sessionAgentModelSelections);

                        let agentMap = newSelections.get(sessionId);
                        if (!agentMap) {
                            agentMap = new Map();
                        } else {

                            agentMap = new Map(agentMap);
                        }

                        agentMap.set(agentName, { providerId, modelId });

                        newSelections.set(sessionId, agentMap);

                        return { sessionAgentModelSelections: newSelections };
                    });
                },

                getAgentModelForSession: (sessionId: string, agentName: string) => {
                    const { sessionAgentModelSelections } = get();
                    const agentMap = sessionAgentModelSelections.get(sessionId);
                    if (!agentMap) return null;
                    return agentMap.get(agentName) || null;
                },

                saveAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string, variant: string | null | undefined) => {
                    set((state) => {
                        const newSelections = new Map(state.sessionAgentModelVariantSelections);

                        let agentMap = newSelections.get(sessionId);
                        if (!agentMap) {
                            agentMap = new Map();
                        } else {
                            agentMap = new Map(agentMap);
                        }

                        let modelMap = agentMap.get(agentName);
                        if (!modelMap) {
                            modelMap = new Map();
                        } else {
                            modelMap = new Map(modelMap);
                        }

                        const modelKey = `${providerId}/${modelId}`;

                        if (variant === undefined) {
                            modelMap.delete(modelKey);

                            if (modelMap.size === 0) {
                                agentMap.delete(agentName);

                                if (agentMap.size === 0) {
                                    newSelections.delete(sessionId);
                                } else {
                                    newSelections.set(sessionId, agentMap);
                                }
                            } else {
                                agentMap.set(agentName, modelMap);
                                newSelections.set(sessionId, agentMap);
                            }
                        } else {
                            modelMap.set(modelKey, variant);
                            agentMap.set(agentName, modelMap);
                            newSelections.set(sessionId, agentMap);
                        }

                        return { sessionAgentModelVariantSelections: newSelections };
                    });
                },

                getAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => {
                    const { sessionAgentModelVariantSelections } = get();
                    const agentMap = sessionAgentModelVariantSelections.get(sessionId);
                    if (!agentMap) return undefined;
                    const modelMap = agentMap.get(agentName);
                    if (!modelMap) return undefined;
                    return modelMap.get(`${providerId}/${modelId}`);
                },
 
                getCurrentAgent: (sessionId: string) => {
                    const { currentAgentContext } = get();
                    return currentAgentContext.get(sessionId);
                },

                getSessionAgentEditMode: (sessionId: string, agentName: string | undefined, defaultMode: EditPermissionMode = getAgentDefaultEditPermission(agentName)) => {
                    if (!sessionId || !agentName) {
                        return defaultMode;
                    }

                    const sessionMap = get().sessionAgentEditModes.get(sessionId);
                    const override = sessionMap?.get(agentName);
                    if (override !== undefined) {
                        return override;
                    }

                    if (sessionId !== GLOBAL_EDIT_MODE_SESSION_ID) {
                        const globalMap = get().sessionAgentEditModes.get(GLOBAL_EDIT_MODE_SESSION_ID);
                        const globalOverride = globalMap?.get(agentName);
                        if (globalOverride !== undefined) {
                            return globalOverride;
                        }
                    }

                    return defaultMode;
                },

                setSessionAgentEditMode: (sessionId: string, agentName: string | undefined, mode: EditPermissionMode, defaultMode: EditPermissionMode = getAgentDefaultEditPermission(agentName)) => {
                    if (!sessionId || !agentName) {
                        return;
                    }

                    const normalizedDefault: EditPermissionMode = defaultMode ?? 'ask';
                    if (normalizedDefault === 'deny' || mode === 'deny') {
                        return;
                    }

                    if (!EDIT_PERMISSION_SEQUENCE.includes(mode)) {
                        return;
                    }

                    set((state) => {
                        const nextMap = new Map(state.sessionAgentEditModes);
                        const agentMap = new Map(nextMap.get(sessionId) ?? new Map());

                        if (mode === normalizedDefault) {
                            agentMap.delete(agentName);
                            if (agentMap.size === 0) {
                                nextMap.delete(sessionId);
                            } else {
                                nextMap.set(sessionId, agentMap);
                            }
                        } else {
                            agentMap.set(agentName, mode);
                            nextMap.set(sessionId, agentMap);
                        }

                        return { sessionAgentEditModes: nextMap };
                    });
                },

                toggleSessionAgentEditMode: (sessionId: string, agentName: string | undefined, defaultMode: EditPermissionMode = getAgentDefaultEditPermission(agentName)) => {
                    if (!sessionId || !agentName) {
                        return;
                    }

                    const normalizedDefault: EditPermissionMode = defaultMode ?? 'ask';
                    if (normalizedDefault === 'deny') {
                        return;
                    }

                    const currentMode = get().getSessionAgentEditMode(sessionId, agentName, normalizedDefault);
                    const currentIndex = EDIT_PERMISSION_SEQUENCE.indexOf(currentMode);
                    const fallbackIndex = EDIT_PERMISSION_SEQUENCE.indexOf(normalizedDefault);
                    const baseIndex = currentIndex >= 0 ? currentIndex : (fallbackIndex >= 0 ? fallbackIndex : 0);
                    const nextIndex = (baseIndex + 1) % EDIT_PERMISSION_SEQUENCE.length;
                    const nextMode = EDIT_PERMISSION_SEQUENCE[nextIndex];

                    get().setSessionAgentEditMode(sessionId, agentName, nextMode, normalizedDefault);
                },

            }),
            {
                name: "context-store",
                storage: createDeferredSafeJSONStorage(),
                partialize: (state) => ({
                    sessionModelSelections: Array.from(state.sessionModelSelections.entries()),
                    sessionAgentSelections: Array.from(state.sessionAgentSelections.entries()),
                    sessionAgentModelSelections: Array.from(state.sessionAgentModelSelections.entries()).map(([sessionId, agentMap]) => [sessionId, Array.from(agentMap.entries())]),
                    sessionAgentModelVariantSelections: Array.from(state.sessionAgentModelVariantSelections.entries()).map(([sessionId, agentMap]) => [
                        sessionId,
                        Array.from(agentMap.entries()).map(([agentName, modelMap]) => [agentName, Array.from(modelMap.entries())]),
                    ]),
                    currentAgentContext: Array.from(state.currentAgentContext.entries()),
                    sessionAgentEditModes: Array.from(state.sessionAgentEditModes.entries()).map(([sessionId, agentMap]) => [sessionId, Array.from(agentMap.entries())]),
                }),
                merge: (persistedState: any, currentState) => {

                    const agentModelSelections = new Map();
                    if (persistedState?.sessionAgentModelSelections) {
                        persistedState.sessionAgentModelSelections.forEach(([sessionId, agentArray]: [string, any[]]) => {
                            agentModelSelections.set(sessionId, new Map(agentArray));
                        });
                    }

                    const agentModelVariantSelections = new Map();
                    if (persistedState?.sessionAgentModelVariantSelections) {
                        persistedState.sessionAgentModelVariantSelections.forEach(([sessionId, agentArray]: [string, any[]]) => {
                            const agentMap = new Map();
                            agentArray.forEach(([agentName, modelArray]: [string, any[]]) => {
                                agentMap.set(agentName, new Map(modelArray));
                            });
                            agentModelVariantSelections.set(sessionId, agentMap);
                        });
                    }
 
                    const agentEditModes = new Map();
                    if (persistedState?.sessionAgentEditModes) {
                        persistedState.sessionAgentEditModes.forEach(([sessionId, agentArray]: [string, any[]]) => {
                            agentEditModes.set(sessionId, new Map(agentArray));
                        });
                    }

                    return {
                        ...currentState,
                        ...(persistedState as object),
                        sessionModelSelections: new Map(persistedState?.sessionModelSelections || []),
                        sessionAgentSelections: new Map(persistedState?.sessionAgentSelections || []),
                        sessionAgentModelSelections: agentModelSelections,
                        sessionAgentModelVariantSelections: agentModelVariantSelections,
                        currentAgentContext: new Map(persistedState?.currentAgentContext || []),
                        sessionAgentEditModes: agentEditModes,
                        hasHydrated: true,
                    };
                },
            }
        ),
        {
            name: "context-store",
        }
    )
);
