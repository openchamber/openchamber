/* eslint-disable @typescript-eslint/no-explicit-any */
import { create } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import type { EditPermissionMode } from "./types/sessionTypes";
import { getAgentDefaultEditPermission } from "./utils/permissionUtils";
import { extractTokensFromMessage } from "./utils/tokenUtils";
import { calculateContextUsage } from "./utils/contextUtils";
import { getSafeStorage } from "./utils/safeStorage";

interface ContextUsage {
    totalTokens: number;
    percentage: number;
    contextLimit: number;
    outputLimit?: number;
    normalizedOutput?: number;
    thresholdLimit: number;
    lastMessageId?: string;
}

interface ContextState {

    sessionModelSelections: Map<string, { providerId: string; modelId: string }>;
    sessionAgentSelections: Map<string, string>;

    sessionAgentModelSelections: Map<string, Map<string, { providerId: string; modelId: string }>>;

    // sessionId → agentName → "providerId/modelId" → variant
    sessionAgentModelVariantSelections: Map<string, Map<string, Map<string, string>>>;
 
    currentAgentContext: Map<string, string>;

    sessionContextUsage: Map<string, ContextUsage>;

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

    saveAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string, variant: string | undefined) => void;
    getAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => string | undefined;
 
    analyzeAndSaveExternalSessionChoices: (sessionId: string, agents: any[], messages: Map<string, { info: any; parts: any[] }[]>) => Promise<Map<string, { providerId: string; modelId: string; timestamp: number }>>;


    getContextUsage: (sessionId: string, contextLimit: number, outputLimit: number, messages: Map<string, { info: any; parts: any[] }[]>) => ContextUsage | null;

    updateSessionContextUsage: (sessionId: string, contextLimit: number, outputLimit: number, messages: Map<string, { info: any; parts: any[] }[]>) => void;

    initializeSessionContextUsage: (sessionId: string, contextLimit: number, outputLimit: number, messages: Map<string, { info: any; parts: any[] }[]>) => void;

    pollForTokenUpdates: (sessionId: string, messageId: string, messages: Map<string, { info: any; parts: any[] }[]>, maxAttempts?: number) => void;

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
                sessionContextUsage: new Map(),
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

                        // Keep a "current" agent context for components that only know sessionId.
                        // This is also used by external-session inference logic.
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

                saveAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string, variant: string | undefined) => {
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
 
                analyzeAndSaveExternalSessionChoices: async (sessionId: string, agents: any[], messages: Map<string, { info: any; parts: any[] }[]>) => {
                    const { saveAgentModelForSession, saveAgentModelVariantForSession } = get();

                    const agentLastChoices = new Map<
                        string,
                        {
                            providerId: string;
                            modelId: string;
                            timestamp: number;
                        }
                    >();

                    const extractAgentFromMessage = (messageInfo: any, messageIndex: number): string | null => {

                        if ("mode" in messageInfo && messageInfo.mode && typeof messageInfo.mode === "string") {
                            const modeAgent = agents.find((a) => a.name === messageInfo.mode);
                            if (modeAgent) {
                                return messageInfo.mode;
                            }
                        }

                        if ("agent" in messageInfo && messageInfo.agent && typeof messageInfo.agent === "string") {
                            const agent = agents.find((a) => a.name === messageInfo.agent);
                            if (agent) {
                                return messageInfo.agent;
                            }
                        }

                        if (messageInfo.providerID && messageInfo.modelID) {
                            const matchingAgent = agents.find((agent) => agent.model?.providerID === messageInfo.providerID && agent.model?.modelID === messageInfo.modelID);
                            if (matchingAgent) {
                                return matchingAgent.name;
                            }
                        }

                        const { currentAgentContext } = get();
                        const contextAgent = currentAgentContext.get(sessionId);
                        if (contextAgent && agents.find((a) => a.name === contextAgent)) {
                            return contextAgent;
                        }

                        if (messageIndex > 0 && messageInfo.providerID && messageInfo.modelID) {

                            const sessionMessages = messages.get(sessionId) || [];
                            const assistantMessages = sessionMessages.filter((m) => m.info.role === "assistant").sort((a, b) => a.info.time.created - b.info.time.created);

                            for (let i = messageIndex - 1; i >= 0; i--) {
                                const prevMessage = assistantMessages[i];
                                const prevInfo = prevMessage.info as any;
                                if (prevInfo.providerID === messageInfo.providerID && prevInfo.modelID === messageInfo.modelID) {

                                    if (prevInfo.mode && typeof prevInfo.mode === "string") {
                                        const prevModeAgent = agents.find((a) => a.name === prevInfo.mode);
                                        if (prevModeAgent) {
                                            return prevInfo.mode;
                                        }
                                    }

                                    const prevMatchingAgent = agents.find((agent) => agent.model?.providerID === prevInfo.providerID && agent.model?.modelID === prevInfo.modelID);
                                    if (prevMatchingAgent) {
                                        return prevMatchingAgent.name;
                                    }
                                }
                            }
                        }

                        if (messageInfo.providerID && messageInfo.modelID) {
                            const buildAgent = agents.find((a) => a.name === "build");
                            if (buildAgent) {
                                return "build";
                            }
                        }

                        return null;
                    };

                    const sessionMessages = messages.get(sessionId) || [];

                    const allMessages = sessionMessages.filter((m: any) => m.info.role === "assistant" || m.info.role === "user").sort((a: any, b: any) => a.info.time.created - b.info.time.created);
                    const assistantMessages = sessionMessages.filter((m: any) => m.info.role === "assistant").sort((a: any, b: any) => a.info.time.created - b.info.time.created);

                    // Track variant from user messages to apply to corresponding assistant response
                    let pendingVariant: string | undefined = undefined;
                    let pendingUserModel: { providerID: string; modelID: string } | undefined = undefined;

                    for (let messageIndex = 0; messageIndex < allMessages.length; messageIndex++) {
                        const message = allMessages[messageIndex];
                        const { info } = message;
                        const infoAny = info as any;

                        // User messages have variant and model info in different structure
                        if (infoAny.role === "user") {
                            const agentName = typeof infoAny.mode === 'string' && infoAny.mode.trim().length > 0
                                ? infoAny.mode
                                : (typeof infoAny.agent === 'string' && infoAny.agent.trim().length > 0 ? infoAny.agent : undefined);

                            const userProvider = typeof infoAny.model?.providerID === 'string' && infoAny.model.providerID.trim().length > 0
                                ? infoAny.model.providerID
                                : (typeof infoAny.providerID === 'string' && infoAny.providerID.trim().length > 0 ? infoAny.providerID : undefined);
                            const userModel = typeof infoAny.model?.modelID === 'string' && infoAny.model.modelID.trim().length > 0
                                ? infoAny.model.modelID
                                : (typeof infoAny.modelID === 'string' && infoAny.modelID.trim().length > 0 ? infoAny.modelID : undefined);

                            const userVariant = typeof infoAny.variant === 'string' && infoAny.variant.trim().length > 0
                                ? infoAny.variant
                                : undefined;

                            if (agentName && userProvider && userModel && agents.find((a) => a.name === agentName)) {
                                const choice = {
                                    providerId: userProvider,
                                    modelId: userModel,
                                    timestamp: info.time.created,
                                };
                                const existing = agentLastChoices.get(agentName);
                                if (!existing || choice.timestamp > existing.timestamp) {
                                    agentLastChoices.set(agentName, choice);
                                }
                                saveAgentModelVariantForSession(sessionId, agentName, userProvider, userModel, userVariant);
                            }

                            // User message: variant is top-level, model is nested in model.providerID/modelID
                            pendingVariant = userVariant;
                            pendingUserModel = infoAny.model?.providerID && infoAny.model?.modelID
                                ? { providerID: infoAny.model.providerID, modelID: infoAny.model.modelID }
                                : undefined;
                            continue;
                        }

                        // Assistant message: providerID/modelID are top-level
                        if (infoAny.providerID && infoAny.modelID) {
                            const agentName = extractAgentFromMessage(infoAny, assistantMessages.indexOf(message));

                            if (agentName && agents.find((a) => a.name === agentName)) {
                                // Apply pending variant from user message if model matches
                                if (pendingUserModel &&
                                    pendingUserModel.providerID === infoAny.providerID &&
                                    pendingUserModel.modelID === infoAny.modelID) {
                                    saveAgentModelVariantForSession(sessionId, agentName, infoAny.providerID, infoAny.modelID, pendingVariant);
                                }

                                const choice = {
                                    providerId: infoAny.providerID,
                                    modelId: infoAny.modelID,
                                    timestamp: info.time.created,
                                };

                                const existing = agentLastChoices.get(agentName);
                                if (!existing || choice.timestamp > existing.timestamp) {
                                    agentLastChoices.set(agentName, choice);
                                }
                            }
                        }

                        // Clear pending variant after processing assistant message
                        pendingVariant = undefined;
                        pendingUserModel = undefined;
                    }

                    for (const [agentName, choice] of agentLastChoices) {
                        saveAgentModelForSession(sessionId, agentName, choice.providerId, choice.modelId);
                    }

                    return agentLastChoices;
                },

                getContextUsage: (sessionId: string, contextLimit: number, outputLimit: number, messages: Map<string, { info: any; parts: any[] }[]>) => {
                    if (!sessionId) return null;

                    const limitsUsage = calculateContextUsage(0, contextLimit, outputLimit);
                    const safeContext = limitsUsage.contextLimit;
                    const normalizedOutput = limitsUsage.normalizedOutput ?? 0;
                    const thresholdLimit = limitsUsage.thresholdLimit;

                    if (safeContext === 0 || thresholdLimit === 0) {
                        return null;
                    }

                    const sessionMessages = messages.get(sessionId) || [];
                    const assistantMessages = sessionMessages.filter(m => m.info.role === 'assistant');

                    if (assistantMessages.length === 0) return null;

                    const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
                    const lastMessageId = lastAssistantMessage.info.id;

                    const scheduleUsageUpdate = (usage: ContextUsage) => {
                        const runUpdate = () => {
                            set((state) => {
                                const existing = state.sessionContextUsage.get(sessionId) as ContextUsage | undefined;
                        if (
                            existing &&
                            existing.totalTokens === usage.totalTokens &&
                            existing.percentage === usage.percentage &&
                            existing.contextLimit === usage.contextLimit &&
                            (existing.outputLimit ?? 0) === (usage.outputLimit ?? 0) &&
                            (existing.normalizedOutput ?? 0) === (usage.normalizedOutput ?? 0) &&
                            existing.thresholdLimit === usage.thresholdLimit &&
                            existing.lastMessageId === usage.lastMessageId
                        ) {
                            return state;
                        }

                                const newContextUsage = new Map(state.sessionContextUsage);
                                newContextUsage.set(sessionId, usage);
                                return { sessionContextUsage: newContextUsage };
                            });
                        };

                        if (typeof queueMicrotask === 'function') {
                            queueMicrotask(runUpdate);
                        } else if (typeof window !== 'undefined') {
                            window.setTimeout(runUpdate, 0);
                        } else {
                            setTimeout(runUpdate, 0);
                        }
                    };

                    const cachedUsage = get().sessionContextUsage.get(sessionId) as ContextUsage | undefined;
                    if (cachedUsage && cachedUsage.lastMessageId === lastMessageId) {
                        const cachedOutput = cachedUsage.normalizedOutput ?? cachedUsage.outputLimit ?? 0;
                        const limitsChanged =
                            cachedUsage.contextLimit !== safeContext ||
                            cachedOutput !== normalizedOutput ||
                            cachedUsage.thresholdLimit !== thresholdLimit;

                        if (limitsChanged && cachedUsage.totalTokens > 0) {
                            const newPercentage = (cachedUsage.totalTokens / thresholdLimit) * 100;
                            const recalculated: ContextUsage = {
                                totalTokens: cachedUsage.totalTokens,
                                percentage: Math.min(newPercentage, 100),
                                contextLimit: safeContext,
                                outputLimit: limitsUsage.outputLimit,
                                normalizedOutput,
                                thresholdLimit,
                                lastMessageId,
                            };
                            scheduleUsageUpdate(recalculated);
                            return recalculated;
                        }

                        if (!limitsChanged && cachedUsage.totalTokens > 0) {
                            return cachedUsage;
                        }
                    }

                    const totalTokens = extractTokensFromMessage(lastAssistantMessage);

                    if (totalTokens === 0) {
                        return cachedUsage || null;
                    }

                    const usage = calculateContextUsage(totalTokens, contextLimit, outputLimit);
                    const result: ContextUsage = {
                        totalTokens,
                        percentage: usage.percentage,
                        contextLimit: usage.contextLimit,
                        outputLimit: usage.outputLimit,
                        normalizedOutput: usage.normalizedOutput,
                        thresholdLimit: usage.thresholdLimit,
                        lastMessageId,
                    };

                    scheduleUsageUpdate(result);

                    return result;
                },

                updateSessionContextUsage: (sessionId: string, contextLimit: number, outputLimit: number, messages: Map<string, { info: any; parts: any[] }[]>) => {
                    const sessionMessages = messages.get(sessionId) || [];
                    const assistantMessages = sessionMessages.filter(m => m.info.role === 'assistant');

                    if (assistantMessages.length === 0) return;

                    const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
                    const totalTokens = extractTokensFromMessage(lastAssistantMessage);

                    if (totalTokens === 0) return;

                    const usage = calculateContextUsage(totalTokens, contextLimit, outputLimit);

                    set((state) => {
                        const newContextUsage = new Map(state.sessionContextUsage);
                        newContextUsage.set(sessionId, {
                            totalTokens,
                            percentage: usage.percentage,
                            contextLimit: usage.contextLimit,
                            outputLimit: usage.outputLimit,
                            normalizedOutput: usage.normalizedOutput,
                            thresholdLimit: usage.thresholdLimit,
                            lastMessageId: lastAssistantMessage.info.id,
                        });
                        return { sessionContextUsage: newContextUsage };
                    });
                },

                initializeSessionContextUsage: (sessionId: string, contextLimit: number, outputLimit: number, messages: Map<string, { info: any; parts: any[] }[]>) => {
                    const state = get();
                    const existingUsage = state.sessionContextUsage.get(sessionId);

                    if (!existingUsage || existingUsage.totalTokens === 0) {
                        get().updateSessionContextUsage(sessionId, contextLimit, outputLimit, messages);
                    }
                },

                pollForTokenUpdates: (sessionId: string, messageId: string, messages: Map<string, { info: any; parts: any[] }[]>, maxAttempts: number = 10) => {
                    let attempts = 0;

                    const poll = () => {
                        attempts++;
                        const sessionMessages = messages.get(sessionId) || [];
                        const message = sessionMessages.find(m => m.info.id === messageId);

                        if (message && message.info.role === 'assistant') {
                            const totalTokens = extractTokensFromMessage(message);

                            if (totalTokens > 0) {

                                get().updateSessionContextUsage(sessionId, 0, 0, messages);
                                return;
                            }
                        }

                        if (attempts < maxAttempts) {
                            setTimeout(poll, 1000);
                        }
                    };

                    setTimeout(poll, 2000);
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

                    // Fallback: global (applies to all sessions)
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
                storage: createJSONStorage(() => getSafeStorage()),
                partialize: (state) => ({
                    sessionModelSelections: Array.from(state.sessionModelSelections.entries()),
                    sessionAgentSelections: Array.from(state.sessionAgentSelections.entries()),
                    sessionAgentModelSelections: Array.from(state.sessionAgentModelSelections.entries()).map(([sessionId, agentMap]) => [sessionId, Array.from(agentMap.entries())]),
                    sessionAgentModelVariantSelections: Array.from(state.sessionAgentModelVariantSelections.entries()).map(([sessionId, agentMap]) => [
                        sessionId,
                        Array.from(agentMap.entries()).map(([agentName, modelMap]) => [agentName, Array.from(modelMap.entries())]),
                    ]),
                    currentAgentContext: Array.from(state.currentAgentContext.entries()),
                    sessionContextUsage: Array.from(state.sessionContextUsage.entries()),
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
                        sessionContextUsage: new Map(persistedState?.sessionContextUsage || []),
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
