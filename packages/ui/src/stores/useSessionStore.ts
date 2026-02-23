import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools } from "zustand/middleware";
import type { Session, Message, Part } from "@opencode-ai/sdk/v2";
import type { PermissionRequest, PermissionResponse } from "@/types/permission";
import type { QuestionRequest } from "@/types/question";
import type { SessionStore, AttachedFile, EditPermissionMode, SyntheticContextPart } from "./types/sessionTypes";
import { getMessageLimit, getBackgroundTrimLimit } from "./types/sessionTypes";

import { useSessionStore as useSessionManagementStore } from "./sessionStore";
import { useMessageStore } from "./messageStore";
import { useFileStore } from "./fileStore";
import { useContextStore } from "./contextStore";
import { usePermissionStore } from "./permissionStore";
import { useQuestionStore } from "./questionStore";
import { opencodeClient } from "@/lib/opencode/client";
import { useDirectoryStore } from "./useDirectoryStore";
import { useConfigStore } from "./useConfigStore";
import { useProjectsStore } from "./useProjectsStore";
import { useSessionFoldersStore } from "./useSessionFoldersStore";
import { EXECUTION_FORK_META_TEXT } from "@/lib/messages/executionMeta";
import { flattenAssistantTextParts } from "@/lib/messages/messageText";

export type { AttachedFile, EditPermissionMode };
export { MEMORY_LIMITS, ACTIVE_SESSION_WINDOW } from "./types/sessionTypes";

declare global {
    interface Window {
        __zustand_session_store__?: UseBoundStore<StoreApi<SessionStore>>;
    }
}

const normalizePath = (value?: string | null): string | null => {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const replaced = trimmed.replace(/\\/g, "/");
    if (replaced === "/") {
        return "/";
    }
    return replaced.length > 1 ? replaced.replace(/\/+$/, "") : replaced;
};

const resolveSessionDirectory = (
    sessions: Session[],
    sessionId: string | null | undefined,
    getWorktreeMetadata: (id: string) => { path?: string } | undefined,
): string | null => {
    if (!sessionId) {
        return null;
    }
    const metadataPath = getWorktreeMetadata(sessionId)?.path;
    if (typeof metadataPath === "string" && metadataPath.trim().length > 0) {
        return normalizePath(metadataPath);
    }

    const target = sessions.find((session) => session.id === sessionId) as { directory?: string | null } | undefined;
    if (!target) {
        return null;
    }
    return normalizePath(target.directory ?? null);
};

export const useSessionStore = create<SessionStore>()(
    devtools(
        (set, get) => ({

            sessions: [],
            sessionsByDirectory: new Map(),
            currentSessionId: null,
            lastLoadedDirectory: null,
            messages: new Map(),
            sessionMemoryState: new Map(),
            messageStreamStates: new Map(),
            sessionCompactionUntil: new Map(),
            sessionAbortFlags: new Map(),
            permissions: new Map(),
            questions: new Map(),
            attachedFiles: [],
            isLoading: false,
            error: null,
            streamingMessageIds: new Map(),
            abortControllers: new Map(),
            lastUsedProvider: null,
            isSyncing: false,
            sessionModelSelections: new Map(),
            sessionAgentSelections: new Map(),
            sessionAgentModelSelections: new Map(),
            webUICreatedSessions: new Set(),
            worktreeMetadata: new Map(),
            availableWorktrees: [],
            availableWorktreesByProject: new Map(),
            currentAgentContext: new Map(),
            sessionContextUsage: new Map(),
            sessionAgentEditModes: new Map(),
            abortPromptSessionId: null,
            abortPromptExpiresAt: null,
            sessionStatus: new Map(),
            sessionAttentionStates: new Map(),
            userSummaryTitles: new Map(),
            pendingInputText: null,
            pendingInputMode: 'replace',
            pendingSyntheticParts: null,
            newSessionDraft: { open: true, directoryOverride: null, parentID: null },

            // Voice state (initialized to disconnected/idle)
            voiceStatus: 'disconnected',
            voiceMode: 'idle',

            // Voice actions
            setVoiceStatus: (status: import("./types/sessionTypes").VoiceStatus) => {
                set({ voiceStatus: status });
            },
            setVoiceMode: (mode: import("./types/sessionTypes").VoiceMode) => {
                set({ voiceMode: mode });
            },

                getSessionAgentEditMode: (sessionId: string, agentName: string | undefined, defaultMode?: EditPermissionMode) => {
                    return useContextStore.getState().getSessionAgentEditMode(sessionId, agentName, defaultMode);
                },

                toggleSessionAgentEditMode: (sessionId: string, agentName: string | undefined, defaultMode?: EditPermissionMode) => {
                    return useContextStore.getState().toggleSessionAgentEditMode(sessionId, agentName, defaultMode);
                },

                setSessionAgentEditMode: (sessionId: string, agentName: string | undefined, mode: EditPermissionMode, defaultMode?: EditPermissionMode) => {
                    return useContextStore.getState().setSessionAgentEditMode(sessionId, agentName, mode, defaultMode);
                },

                loadSessions: () => useSessionManagementStore.getState().loadSessions(),

                openNewSessionDraft: (options) => {
                    // Use explicit directoryOverride if provided, otherwise use active project path
                    let directory: string | null = null;
                    if (options?.directoryOverride !== undefined) {
                        directory = options.directoryOverride;
                    } else {
                        const activeProject = useProjectsStore.getState().getActiveProject();
                        directory = activeProject?.path ?? null;
                    }

                    set({
                        newSessionDraft: {
                            open: true,
                            directoryOverride: directory,
                            parentID: options?.parentID ?? null,
                            title: options?.title,
                            initialPrompt: options?.initialPrompt,
                            syntheticParts: options?.syntheticParts,
                            targetFolderId: options?.targetFolderId,
                        },
                        currentSessionId: null,
                        error: null,
                        // Set pending input text if initialPrompt is provided
                        ...(options?.initialPrompt ? { pendingInputText: options.initialPrompt, pendingInputMode: 'replace' as const } : {}),
                    });

                    try {
                        const configState = useConfigStore.getState();
                        const visibleAgents = configState.getVisibleAgents();

                        // Priority: settingsDefaultAgent → build → first visible
                        let agentName: string | undefined;
                        if (configState.settingsDefaultAgent) {
                            const settingsAgent = visibleAgents.find((a) => a.name === configState.settingsDefaultAgent);
                            if (settingsAgent) {
                                agentName = settingsAgent.name;
                            }
                        }
                        if (!agentName) {
                            agentName =
                                visibleAgents.find((agent) => agent.name === 'build')?.name ||
                                visibleAgents[0]?.name;
                        }

                        if (agentName) {
                            configState.setAgent(agentName);
                        }
                    } catch {
                        // ignored
                    }
                },

                closeNewSessionDraft: () => {
                    const realCurrentSessionId = useSessionManagementStore.getState().currentSessionId;
                    set({
                        newSessionDraft: { open: false, directoryOverride: null, parentID: null, title: undefined, initialPrompt: undefined, syntheticParts: undefined, targetFolderId: undefined },
                        currentSessionId: realCurrentSessionId,
                    });
                },

                createSession: async (title?: string, directoryOverride?: string | null, parentID?: string | null) => {
                    const draft = get().newSessionDraft;
                    const targetFolderId = draft.targetFolderId;
                    get().closeNewSessionDraft();

                    const result = await useSessionManagementStore.getState().createSession(title, directoryOverride, parentID);

                    if (result?.id) {
                        await get().setCurrentSession(result.id);
                        const finalScopeKey = directoryOverride || get().lastLoadedDirectory || result.directory;
                        if (targetFolderId && finalScopeKey) {
                            useSessionFoldersStore.getState().addSessionToFolder(finalScopeKey, targetFolderId, result.id);
                        }
                    }
                    return result;
                },
                createSessionFromAssistantMessage: async (sourceMessageId: string) => {
                    if (!sourceMessageId) {
                        return;
                    }

                    const messageStore = useMessageStore.getState();
                    const { messages, lastUsedProvider } = messageStore;
                    let sourceEntry: { info: Message; parts: Part[] } | undefined;
                    let sourceSessionId: string | undefined;

                    messages.forEach((messageList, sessionId) => {
                        const found = messageList.find((entry) => entry.info?.id === sourceMessageId);
                        if (found && !sourceEntry) {
                            sourceEntry = found;
                            sourceSessionId = sessionId;
                        }
                    });

                    if (!sourceEntry || sourceEntry.info.role !== "assistant") {
                        return;
                    }

                    const assistantPlanText = flattenAssistantTextParts(sourceEntry.parts);
                    if (!assistantPlanText.trim()) {
                        return;
                    }

                    const sessionManagementStore = useSessionManagementStore.getState();
                    const directory = resolveSessionDirectory(
                        sessionManagementStore.sessions,
                        sourceSessionId ?? null,
                        sessionManagementStore.getWorktreeMetadata,
                    );

                    const session = await get().createSession(undefined, directory ?? null, null);
                    if (!session) {
                        return;
                    }

                    const { currentProviderId, currentModelId, currentAgentName } = useConfigStore.getState();
                    const providerID = currentProviderId || lastUsedProvider?.providerID;
                    const modelID = currentModelId || lastUsedProvider?.modelID;

                    if (!providerID || !modelID) {
                        return;
                    }

                    await opencodeClient.sendMessage({
                        id: session.id,
                        providerID,
                        modelID,
                        text: assistantPlanText,
                        prefaceText: EXECUTION_FORK_META_TEXT,
                        agent: currentAgentName ?? undefined,
                    });
                },
                deleteSession: (id: string, options) => useSessionManagementStore.getState().deleteSession(id, options),
                deleteSessions: (ids: string[], options) => useSessionManagementStore.getState().deleteSessions(ids, options),
                updateSessionTitle: (id: string, title: string) => useSessionManagementStore.getState().updateSessionTitle(id, title),
                shareSession: (id: string) => useSessionManagementStore.getState().shareSession(id),
                unshareSession: (id: string) => useSessionManagementStore.getState().unshareSession(id),
                setCurrentSession: async (id: string | null) => {
                    if (id) {
                        get().closeNewSessionDraft();
                    }

                    const previousSessionId = useSessionManagementStore.getState().currentSessionId;

                    const sessionDirectory = resolveSessionDirectory(
                        useSessionManagementStore.getState().sessions,
                        id,
                        useSessionManagementStore.getState().getWorktreeMetadata
                    );
                    const fallbackDirectory = opencodeClient.getDirectory() ?? useDirectoryStore.getState().currentDirectory ?? null;
                    const resolvedDirectory = sessionDirectory ?? fallbackDirectory;

                    try {
                        opencodeClient.setDirectory(resolvedDirectory ?? undefined);
                    } catch (error) {
                        console.warn("Failed to set OpenCode directory for session switch:", error);
                    }

                    if (previousSessionId && previousSessionId !== id) {
                        const memoryState = get().sessionMemoryState.get(previousSessionId);
                        if (!memoryState?.isStreaming) {

                            const previousMessages = get().messages.get(previousSessionId) || [];
                            if (previousMessages.length > 0) {
                                get().updateViewportAnchor(previousSessionId, previousMessages.length - 1);
                            }

                            get().trimToViewportWindow(previousSessionId, getBackgroundTrimLimit());
                        }
                    }

                    useSessionManagementStore.getState().setCurrentSession(id);

                    if (id) {

                        const existingMessages = get().messages.get(id);
                        const memoryState = get().sessionMemoryState.get(id);
                        const needsHistoryBootstrap =
                            !memoryState ||
                            memoryState.historyComplete === undefined;

                        if (!existingMessages || needsHistoryBootstrap) {

                            await get().loadMessages(id);
                        }

                        get().trimToViewportWindow(id, getMessageLimit());

                        // Analyze session messages to extract agent/model/variant choices
                        // This ensures context is available even when ModelControls isn't mounted
                        const sessionMessages = get().messages.get(id);
                        if (sessionMessages && sessionMessages.length > 0) {
                            const agents = useConfigStore.getState().agents;
                            if (agents.length > 0) {
                                try {
                                    await useContextStore.getState().analyzeAndSaveExternalSessionChoices(
                                        id,
                                        agents,
                                        get().messages
                                    );
                                } catch (error) {
                                    console.warn('Failed to analyze session choices:', error);
                                }
                            }
                        }
                    }

                    get().evictLeastRecentlyUsed();
                },
                loadMessages: (sessionId: string, limit?: number) => useMessageStore.getState().loadMessages(sessionId, limit),
                sendMessage: async (content: string, providerID: string, modelID: string, agent?: string, attachments?: AttachedFile[], agentMentionName?: string, additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }>, variant?: string, inputMode: 'normal' | 'shell' = 'normal') => {
                    const draft = get().newSessionDraft;
                    const trimmedAgent = typeof agent === 'string' && agent.trim().length > 0 ? agent.trim() : undefined;

                    const setStatus = (sessionId: string, type: 'idle' | 'busy') => {
                        set((state) => {
                            const next = new Map(state.sessionStatus ?? new Map());
                            next.set(sessionId, { type });
                            return { sessionStatus: next };
                        });
                    };

                    if (draft?.open) {
                        const draftTargetFolderId = draft.targetFolderId;
                        const draftDirectoryOverride = draft.directoryOverride ?? null;

                        const created = await useSessionManagementStore
                            .getState()
                            .createSession(draft.title, draftDirectoryOverride, draft.parentID ?? null);

                        if (!created?.id) {
                            throw new Error('Failed to create session');
                        }

                        const configState = useConfigStore.getState();
                        const draftAgentName = configState.currentAgentName;
                        const effectiveDraftAgent = trimmedAgent ?? draftAgentName;
                        const draftProviderId = configState.currentProviderId;
                        const draftModelId = configState.currentModelId;

                        if (draftProviderId && draftModelId) {
                            try {
                                useContextStore.getState().saveSessionModelSelection(created.id, draftProviderId, draftModelId);
                            } catch {
                                // ignored
                            }
                        }

                        if (effectiveDraftAgent) {
                            try {
                                useContextStore.getState().saveSessionAgentSelection(created.id, effectiveDraftAgent);
                            } catch {
                                // ignored
                            }

                                if (draftProviderId && draftModelId) {
                                    try {
                                        useContextStore
                                            .getState()
                                            .saveAgentModelForSession(created.id, effectiveDraftAgent, draftProviderId, draftModelId);
                                    } catch {
                                        // ignored
                                    }

                                    if (variant !== undefined) {
                                        try {
                                            useContextStore
                                                .getState()
                                                .saveAgentModelVariantForSession(created.id, effectiveDraftAgent, draftProviderId, draftModelId, variant);
                                        } catch {
                                            // ignored
                                        }
                                    }
                                }
                        }

                        try {
                            useSessionManagementStore
                                .getState()
                                .initializeNewOpenChamberSession(created.id, configState.agents);
                        } catch {
                            // ignored
                        }

                        // Capture synthetic parts before clearing draft
                        const draftSyntheticParts = draft.syntheticParts;

                        get().closeNewSessionDraft();

                        // Assign to target folder if session was created from folder's + button
                        if (draftTargetFolderId) {
                            const scopeKey = draftDirectoryOverride || created.directory || null;
                            if (scopeKey) {
                                useSessionFoldersStore.getState().addSessionToFolder(scopeKey, draftTargetFolderId, created.id);
                            }
                        }

                        setStatus(created.id, 'busy');

                        // Merge draft synthetic parts with any additional parts passed to sendMessage
                        const mergedAdditionalParts = draftSyntheticParts?.length
                            ? [...(additionalParts || []), ...draftSyntheticParts]
                            : additionalParts;

                        try {
                            return await useMessageStore
                                .getState()
                                .sendMessage(content, providerID, modelID, effectiveDraftAgent, created.id, attachments, agentMentionName, mergedAdditionalParts, variant, inputMode);
                        } catch (error) {
                            setStatus(created.id, 'idle');
                            throw error;
                        }
                    }

                    const currentSessionId = useSessionManagementStore.getState().currentSessionId;
                    const sessionAgentSelection = currentSessionId
                        ? useContextStore.getState().getSessionAgentSelection(currentSessionId)
                        : null;
                    const configAgentName = useConfigStore.getState().currentAgentName;
                    const effectiveAgent = trimmedAgent || sessionAgentSelection || configAgentName || undefined;

                    if (currentSessionId && effectiveAgent) {
                        try {
                            useContextStore.getState().saveSessionAgentSelection(currentSessionId, effectiveAgent);
                        } catch {
                            // ignored
                        }

                        if (variant !== undefined) {
                            try {
                                useContextStore
                                    .getState()
                                    .saveAgentModelVariantForSession(currentSessionId, effectiveAgent, providerID, modelID, variant);
                            } catch {
                                // ignored
                            }
                        }
                    }
 
                    if (currentSessionId) {
                        setStatus(currentSessionId, 'busy');

                        const memoryState = get().sessionMemoryState.get(currentSessionId);
                        if (!memoryState || !memoryState.lastUserMessageAt) {
                            const currentMemoryState = get().sessionMemoryState;
                            const newMemoryState = new Map(currentMemoryState);
                            newMemoryState.set(currentSessionId, {
                                viewportAnchor: memoryState?.viewportAnchor ?? 0,
                                isStreaming: memoryState?.isStreaming ?? false,
                                lastAccessedAt: Date.now(),
                                backgroundMessageCount: memoryState?.backgroundMessageCount ?? 0,
                                lastUserMessageAt: Date.now(),
                            });
                            set({ sessionMemoryState: newMemoryState });
                        }
                    }

                    // Notify server that user sent a message in this session
                    if (currentSessionId) {
                        fetch(`/api/sessions/${currentSessionId}/message-sent`, { method: 'POST' })
                            .catch(() => { /* ignore */ });
                    }

                    try {
                        return await useMessageStore.getState().sendMessage(content, providerID, modelID, effectiveAgent, currentSessionId || undefined, attachments, agentMentionName, additionalParts, variant, inputMode);
                    } catch (error) {
                        if (currentSessionId) {
                            setStatus(currentSessionId, 'idle');
                        }
                        throw error;
                    }
                },
                abortCurrentOperation: () => {
                    const currentSessionId = useSessionManagementStore.getState().currentSessionId;
                    return useMessageStore.getState().abortCurrentOperation(currentSessionId || undefined);
                },
                armAbortPrompt: (durationMs = 3000) => {
                    const sessionId = useSessionManagementStore.getState().currentSessionId;
                    if (!sessionId) {
                        return null;
                    }
                    const expiresAt = Date.now() + durationMs;
                    set({ abortPromptSessionId: sessionId, abortPromptExpiresAt: expiresAt });
                    return expiresAt;
                },
                clearAbortPrompt: () => {
                    set({ abortPromptSessionId: null, abortPromptExpiresAt: null });
                },
                acknowledgeSessionAbort: (sessionId: string) => {
                    if (!sessionId) {
                        return;
                    }
                    useMessageStore.getState().acknowledgeSessionAbort(sessionId);
                },
                addStreamingPart: (sessionId: string, messageId: string, part: Part, role?: string) => {
                    const currentSessionId = useSessionManagementStore.getState().currentSessionId;

                    const effectiveCurrent = currentSessionId || sessionId;
                    return useMessageStore.getState().addStreamingPart(sessionId, messageId, part, role, effectiveCurrent);
                },
                completeStreamingMessage: (sessionId: string, messageId: string) => useMessageStore.getState().completeStreamingMessage(sessionId, messageId),
                markMessageStreamSettled: (messageId: string) => useMessageStore.getState().markMessageStreamSettled(messageId),
                updateMessageInfo: (sessionId: string, messageId: string, messageInfo: Record<string, unknown>) => useMessageStore.getState().updateMessageInfo(sessionId, messageId, messageInfo),
                updateSessionCompaction: (sessionId: string, compactingTimestamp?: number | null) => useMessageStore.getState().updateSessionCompaction(sessionId, compactingTimestamp ?? null),
                addPermission: (permission: PermissionRequest) => {
                    const contextData = {
                        currentAgentContext: useContextStore.getState().currentAgentContext,
                        sessionAgentSelections: useContextStore.getState().sessionAgentSelections,
                        getSessionAgentEditMode: useContextStore.getState().getSessionAgentEditMode,
                    };
                    return usePermissionStore.getState().addPermission(permission, contextData);
                },
                respondToPermission: (sessionId: string, requestId: string, response: PermissionResponse) => usePermissionStore.getState().respondToPermission(sessionId, requestId, response),
                dismissPermission: (sessionId: string, requestId: string) => usePermissionStore.getState().dismissPermission(sessionId, requestId),

                addQuestion: (question: QuestionRequest) => useQuestionStore.getState().addQuestion(question),
                dismissQuestion: (sessionId: string, requestId: string) => useQuestionStore.getState().dismissQuestion(sessionId, requestId),
                respondToQuestion: (sessionId: string, requestId: string, answers: string[] | string[][]) => useQuestionStore.getState().respondToQuestion(sessionId, requestId, answers),
                rejectQuestion: (sessionId: string, requestId: string) => useQuestionStore.getState().rejectQuestion(sessionId, requestId),

                clearError: () => useSessionManagementStore.getState().clearError(),
                getSessionsByDirectory: (directory: string) => useSessionManagementStore.getState().getSessionsByDirectory(directory),
                getDirectoryForSession: (sessionId: string) => useSessionManagementStore.getState().getDirectoryForSession(sessionId),
                getLastMessageModel: (sessionId: string) => useMessageStore.getState().getLastMessageModel(sessionId),
                getCurrentAgent: (sessionId: string) => useContextStore.getState().getCurrentAgent(sessionId),
                syncMessages: (sessionId: string, messages: { info: Message; parts: Part[] }[]) => useMessageStore.getState().syncMessages(sessionId, messages),
                applySessionMetadata: (sessionId: string, metadata: Partial<Session>) => useSessionManagementStore.getState().applySessionMetadata(sessionId, metadata),

                addAttachedFile: (file: File) => useFileStore.getState().addAttachedFile(file),
                addServerFile: (path: string, name: string, content?: string) => useFileStore.getState().addServerFile(path, name, content),
                removeAttachedFile: (id: string) => useFileStore.getState().removeAttachedFile(id),
                clearAttachedFiles: () => useFileStore.getState().clearAttachedFiles(),

                updateViewportAnchor: (sessionId: string, anchor: number) => useMessageStore.getState().updateViewportAnchor(sessionId, anchor),
                trimToViewportWindow: (sessionId: string, targetSize?: number) => {
                    const currentSessionId = useSessionManagementStore.getState().currentSessionId;
                    // Skip trimming while session is working (busy/retry)
                    const status = get().sessionStatus?.get(sessionId);
                    if (status?.type === 'busy' || status?.type === 'retry') {
                        return;
                    }
                    return useMessageStore.getState().trimToViewportWindow(sessionId, targetSize, currentSessionId || undefined);
                },
                evictLeastRecentlyUsed: () => {
                    const currentSessionId = useSessionManagementStore.getState().currentSessionId;
                    return useMessageStore.getState().evictLeastRecentlyUsed(currentSessionId || undefined);
                },
                loadMoreMessages: (sessionId: string, direction: "up" | "down") => useMessageStore.getState().loadMoreMessages(sessionId, direction),

                saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => useContextStore.getState().saveSessionModelSelection(sessionId, providerId, modelId),
                getSessionModelSelection: (sessionId: string) => useContextStore.getState().getSessionModelSelection(sessionId),
                saveSessionAgentSelection: (sessionId: string, agentName: string) => useContextStore.getState().saveSessionAgentSelection(sessionId, agentName),
                getSessionAgentSelection: (sessionId: string) => useContextStore.getState().getSessionAgentSelection(sessionId),
                saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => useContextStore.getState().saveAgentModelForSession(sessionId, agentName, providerId, modelId),
                getAgentModelForSession: (sessionId: string, agentName: string) => useContextStore.getState().getAgentModelForSession(sessionId, agentName),
                saveAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string, variant: string | undefined) => useContextStore.getState().saveAgentModelVariantForSession(sessionId, agentName, providerId, modelId, variant),
                getAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => useContextStore.getState().getAgentModelVariantForSession(sessionId, agentName, providerId, modelId),
                analyzeAndSaveExternalSessionChoices: (sessionId: string, agents: Record<string, unknown>[]) => { 
                    const messages = useMessageStore.getState().messages;
                    return useContextStore.getState().analyzeAndSaveExternalSessionChoices(sessionId, agents, messages);
                },
                isOpenChamberCreatedSession: (sessionId: string) => useSessionManagementStore.getState().isOpenChamberCreatedSession(sessionId),
                markSessionAsOpenChamberCreated: (sessionId: string) => useSessionManagementStore.getState().markSessionAsOpenChamberCreated(sessionId),
                initializeNewOpenChamberSession: (sessionId: string, agents: Record<string, unknown>[]) => useSessionManagementStore.getState().initializeNewOpenChamberSession(sessionId, agents),
                setWorktreeMetadata: (sessionId: string, metadata) => useSessionManagementStore.getState().setWorktreeMetadata(sessionId, metadata),
                setSessionDirectory: (sessionId: string, directory: string | null) => useSessionManagementStore.getState().setSessionDirectory(sessionId, directory),
                getWorktreeMetadata: (sessionId: string) => useSessionManagementStore.getState().getWorktreeMetadata(sessionId),
                getContextUsage: (contextLimit: number, outputLimit: number) => {
                    if (get().newSessionDraft?.open) {
                        return null;
                    }

                    const currentSessionId = useSessionManagementStore.getState().currentSessionId;
                    if (!currentSessionId) return null;
                    const messages = useMessageStore.getState().messages;
                    return useContextStore.getState().getContextUsage(currentSessionId, contextLimit, outputLimit, messages);
                },
                updateSessionContextUsage: (sessionId: string, contextLimit: number, outputLimit: number) => {
                    const messages = useMessageStore.getState().messages;
                    return useContextStore.getState().updateSessionContextUsage(sessionId, contextLimit, outputLimit, messages);
                },
                initializeSessionContextUsage: (sessionId: string, contextLimit: number, outputLimit: number) => {
                    const messages = useMessageStore.getState().messages;
                    return useContextStore.getState().initializeSessionContextUsage(sessionId, contextLimit, outputLimit, messages);
                },
                debugSessionMessages: async (sessionId: string) => {
                    const messages = useMessageStore.getState().messages.get(sessionId) || [];
                    const session = useSessionManagementStore.getState().sessions.find(s => s.id === sessionId);
                    console.log(`Debug session ${sessionId}:`, {
                        session,
                        messageCount: messages.length,
                        messages: messages.map(m => ({
                            id: m.info.id,
                            role: m.info.role,
                            parts: m.parts.length,
                            tokens: (m.info as Record<string, unknown>).tokens
                        }))
                    });
                },
                pollForTokenUpdates: (sessionId: string, messageId: string, maxAttempts?: number) => {
                    const messages = useMessageStore.getState().messages;
                    return useContextStore.getState().pollForTokenUpdates(sessionId, messageId, messages, maxAttempts);
                },
                updateSession: (session: Session) => useSessionManagementStore.getState().updateSession(session),
                removeSessionFromStore: (sessionId: string) => useSessionManagementStore.getState().removeSessionFromStore(sessionId),

                revertToMessage: async (sessionId: string, messageId: string) => {
                    // Get the message text before reverting
                    const messages = useMessageStore.getState().messages.get(sessionId) || [];
                    const targetMessage = messages.find((m) => m.info.id === messageId);
                    let messageText = '';

                    if (targetMessage && targetMessage.info.role === 'user') {
                        // Extract text from user message parts
                        const textParts = targetMessage.parts.filter((p) => p.type === 'text');
                        messageText = textParts
                            .map((p) => {
                                const part = p as { text?: string; content?: string };
                                return part.text || part.content || '';
                            })
                            .join('\n')
                            .trim();
                    }

                    // Call revert API
                    const updatedSession = await opencodeClient.revertSession(sessionId, messageId);

                    // Update session in store (this stores the revert.messageID)
                    useSessionManagementStore.getState().updateSession(updatedSession);

                    // Filter out reverted messages from the store
                    // Messages with ID >= revert.messageID should be removed
                    const currentMessages = useMessageStore.getState().messages.get(sessionId) || [];
                    const revertMessageId = updatedSession.revert?.messageID;

                    if (revertMessageId) {
                        // Find the index of the revert message
                        const revertIndex = currentMessages.findIndex((m) => m.info.id === revertMessageId);
                        if (revertIndex !== -1) {
                            // Keep only messages before the revert point
                            const filteredMessages = currentMessages.slice(0, revertIndex);
                            useMessageStore.getState().syncMessages(sessionId, filteredMessages);
                        }
                    }

                    // Set pending input text for ChatInput to consume
                    if (messageText) {
                        set({ pendingInputText: messageText, pendingInputMode: 'replace' });
                    }
                },

                handleSlashUndo: async (sessionId: string) => {
                    const messages = get().messages.get(sessionId) || [];
                    const userMessages = messages.filter(m => m.info.role === 'user');
                    const sessions = get().sessions;
                    const currentSession = sessions.find(s => s.id === sessionId);

                    // No-op when there is nothing to undo/redo
                    if (userMessages.length === 0) {
                        return;
                    }

                    // Get current revert state to determine which message to undo next
                    const revertToId = currentSession?.revert?.messageID;

                    // Find the user message AFTER the revert point (or last message if no revert)
                    let targetMessage;
                    if (revertToId) {
                        const revertIndex = userMessages.findIndex(m => m.info.id === revertToId);
                        targetMessage = userMessages[revertIndex + 1];
                    } else {
                        targetMessage = userMessages[userMessages.length - 1];
                    }

                    // No-op when there is nothing to undo/redo
                    if (!targetMessage) {
                        return;
                    }

                    // Helper to extract text preview
                    const textPart = targetMessage.parts.find(p => p.type === 'text');
                    const preview = typeof textPart === 'object' && textPart && 'text' in textPart
                        ? String(textPart.text).slice(0, 50) + (String(textPart.text).length > 50 ? '...' : '')
                        : '[No text]';

                    await get().revertToMessage(sessionId, targetMessage.info.id);

                    const { toast } = await import('sonner');
                    toast.success(`Undid to: ${preview}`);
                },

                handleSlashRedo: async (sessionId: string) => {
                    const sessions = get().sessions;
                    const currentSession = sessions.find(s => s.id === sessionId);
                    const revertToId = currentSession?.revert?.messageID;

                    // No-op when there is nothing to undo/redo
                    if (!revertToId) {
                        return;
                    }

                    const messages = get().messages.get(sessionId) || [];
                    const userMessages = messages.filter(m => m.info.role === 'user');

                    // Find the user message BEFORE the revert point
                    const revertIndex = userMessages.findIndex(m => m.info.id === revertToId);
                    const targetMessage = userMessages[revertIndex - 1];

                    if (targetMessage) {
                        // Partial redo: move to previous message
                        const textPart = targetMessage.parts.find(p => p.type === 'text');
                        const preview = typeof textPart === 'object' && textPart && 'text' in textPart
                            ? String(textPart.text).slice(0, 50) + (String(textPart.text).length > 50 ? '...' : '')
                            : '[No text]';

                        await get().revertToMessage(sessionId, targetMessage.info.id);

                        const { toast } = await import('sonner');
                        toast.success(`Redid to: ${preview}`);
                    } else {
                        // Full unrevert: restore all
                        const session = await opencodeClient.unrevertSession(sessionId);
                        await useSessionManagementStore.getState().updateSession(session);
                        await get().loadMessages(sessionId);

                        const { toast } = await import('sonner');
                        toast.success('Restored all messages');
                    }
                },

                forkFromMessage: async (sessionId: string, messageId: string) => {
                    const sessions = get().sessions;
                    const existingSession = sessions.find(s => s.id === sessionId);
                    if (!existingSession) return;

                    try {
                        // 1. Call SDK fork - backend copies all messages up to messageId
                        const result = await opencodeClient.forkSession(sessionId, messageId);

                        if (!result || !result.id) {
                            const { toast } = await import('sonner');
                            toast.error('Failed to fork session');
                            return;
                        }

                        // 2. Extract fork point content for input field (text + file attachments)
                        const messages = get().messages.get(sessionId) || [];
                        const message = messages.find(m => m.info.id === messageId);

                        if (!message) {
                            const { toast } = await import('sonner');
                            toast.error('Message not found');
                            return;
                        }

                        // Extract text content from non-synthetic, non-ignored text parts
                        let inputText = '';
                        for (const part of message.parts) {
                            if (part.type === 'text' && !part.synthetic && !part.ignored) {
                                const typedPart = part as { text?: string };
                                inputText += typedPart.text || '';
                            }
                        }

                        // 3. Switch to new session
                        get().setCurrentSession(result.id);

                        // 4. Show fork point as pending input (will populate ChatInput)
                        if (inputText) {
                            set({ pendingInputText: inputText, pendingInputMode: 'replace' });
                        }

                        // Load the new session's messages
                        await get().loadMessages(result.id);

                        const { toast } = await import('sonner');
                        toast.success(`Forked from ${existingSession.title}`);
                    } catch (error) {
                        console.error('Failed to fork session:', error);
                        const { toast } = await import('sonner');
                        toast.error('Failed to fork session');
                    }
                },

                setPendingInputText: (text: string | null, mode: 'replace' | 'append' = 'replace') => {
                    set({ pendingInputText: text, pendingInputMode: mode });
                },

                consumePendingInputText: () => {
                    const text = get().pendingInputText;
                    const mode = get().pendingInputMode;
                    if (text !== null) {
                        set({ pendingInputText: null, pendingInputMode: 'replace' });
                    }
                    if (text === null) {
                        return null;
                    }
                    return { text, mode };
                },

                setPendingSyntheticParts: (parts: SyntheticContextPart[] | null) => {
                    set({ pendingSyntheticParts: parts });
                },

                consumePendingSyntheticParts: () => {
                    const parts = get().pendingSyntheticParts;
                    if (parts !== null) {
                        set({ pendingSyntheticParts: null });
                    }
                    return parts;
                },
            }),
        {
            name: "composed-session-store",
        }
    ),
);

// rAF debounce IDs for useMessageStore -> useSessionStore sync
let messageStoreSyncRafId: number | null = null;
let userSummaryTitlesRafId: ReturnType<typeof setTimeout> | null = null;

useSessionManagementStore.subscribe((state, prevState) => {

    if (
        state.sessions === prevState.sessions &&
        state.sessionsByDirectory === prevState.sessionsByDirectory &&
        state.currentSessionId === prevState.currentSessionId &&
        state.lastLoadedDirectory === prevState.lastLoadedDirectory &&
        state.isLoading === prevState.isLoading &&
        state.error === prevState.error &&
        state.webUICreatedSessions === prevState.webUICreatedSessions &&
        state.worktreeMetadata === prevState.worktreeMetadata &&
        state.availableWorktrees === prevState.availableWorktrees &&
        state.availableWorktreesByProject === prevState.availableWorktreesByProject
    ) {
        return;
    }

    const draftOpen = useSessionStore.getState().newSessionDraft?.open;

    useSessionStore.setState({
        sessions: state.sessions,
        sessionsByDirectory: state.sessionsByDirectory,
        currentSessionId: draftOpen ? null : state.currentSessionId,
        lastLoadedDirectory: state.lastLoadedDirectory,
        isLoading: state.isLoading,
        error: state.error,
        webUICreatedSessions: state.webUICreatedSessions,
        worktreeMetadata: state.worktreeMetadata,
        availableWorktrees: state.availableWorktrees,
        availableWorktreesByProject: state.availableWorktreesByProject,
    });
});

useMessageStore.subscribe((state, prevState) => {
    // Early-return equality check stays outside the rAF so we skip scheduling
    // entirely when nothing relevant changed.
    if (
        state.messages === prevState.messages &&
        state.sessionMemoryState === prevState.sessionMemoryState &&
        state.messageStreamStates === prevState.messageStreamStates &&
        state.sessionCompactionUntil === prevState.sessionCompactionUntil &&
        state.sessionAbortFlags === prevState.sessionAbortFlags &&
        state.streamingMessageIds === prevState.streamingMessageIds &&
        state.abortControllers === prevState.abortControllers &&
        state.lastUsedProvider === prevState.lastUsedProvider &&
        state.isSyncing === prevState.isSyncing
    ) {
        return;
    }

    // Debounce the expensive sessionStore update to at most once per animation
    // frame. Multiple messageStore updates within the same frame (e.g. several
    // SSE tokens arriving before the next paint) collapse into a single setState.
    if (messageStoreSyncRafId !== null) {
        cancelAnimationFrame(messageStoreSyncRafId);
    }
    messageStoreSyncRafId = requestAnimationFrame(() => {
        messageStoreSyncRafId = null;

        // Read the LATEST state at flush time, not the stale state captured by
        // the subscription closure.
        const latest = useMessageStore.getState();

        useSessionStore.setState({
            messages: latest.messages,
            sessionMemoryState: latest.sessionMemoryState,
            messageStreamStates: latest.messageStreamStates,
            sessionCompactionUntil: latest.sessionCompactionUntil,
            sessionAbortFlags: latest.sessionAbortFlags,
            streamingMessageIds: latest.streamingMessageIds,
            abortControllers: latest.abortControllers,
            lastUsedProvider: latest.lastUsedProvider,
            isSyncing: latest.isSyncing,
        });

        // Sidebar titles don't need real-time updates; debounce separately at
        // 500 ms so the expensive per-message iteration doesn't happen every
        // frame during streaming.
        if (userSummaryTitlesRafId !== null) {
            clearTimeout(userSummaryTitlesRafId);
        }
        userSummaryTitlesRafId = setTimeout(() => {
            userSummaryTitlesRafId = null;
            const titleState = useMessageStore.getState();
            const userSummaryTitles = new Map<string, { title: string; createdAt: number | null }>();
            titleState.messages.forEach((messageList, sessionId) => {
                if (!Array.isArray(messageList) || messageList.length === 0) {
                    return;
                }
                for (let index = messageList.length - 1; index >= 0; index -= 1) {
                    const entry = messageList[index];
                    if (!entry || !entry.info) {
                        continue;
                    }
                    const info = entry.info as Message & {
                        summary?: { title?: string | null } | null;
                        time?: { created?: number | null };
                    };
                    if (info.role === "user") {
                        const title = info.summary?.title;
                        if (typeof title === "string") {
                            const trimmed = title.trim();
                            if (trimmed.length > 0) {
                                const createdAt =
                                    info.time && typeof info.time.created === "number"
                                        ? info.time.created
                                        : null;
                                userSummaryTitles.set(sessionId, { title: trimmed, createdAt });
                                break;
                            }
                        }
                    }
                }
            });
            useSessionStore.setState({ userSummaryTitles });
        }, 500);
    });
});

useFileStore.subscribe((state, prevState) => {
    if (state.attachedFiles === prevState.attachedFiles) {
        return;
    }

    useSessionStore.setState({
        attachedFiles: state.attachedFiles,
    });
});

useContextStore.subscribe((state, prevState) => {
    if (
        state.sessionModelSelections === prevState.sessionModelSelections &&
        state.sessionAgentSelections === prevState.sessionAgentSelections &&
        state.sessionAgentModelSelections === prevState.sessionAgentModelSelections &&
        state.currentAgentContext === prevState.currentAgentContext &&
        state.sessionContextUsage === prevState.sessionContextUsage &&
        state.sessionAgentEditModes === prevState.sessionAgentEditModes
    ) {
        return;
    }

    useSessionStore.setState({
        sessionModelSelections: state.sessionModelSelections,
        sessionAgentSelections: state.sessionAgentSelections,
        sessionAgentModelSelections: state.sessionAgentModelSelections,
        currentAgentContext: state.currentAgentContext,
        sessionContextUsage: state.sessionContextUsage,
        sessionAgentEditModes: state.sessionAgentEditModes,
    });
});

usePermissionStore.subscribe((state, prevState) => {
    if (state.permissions === prevState.permissions) {
        return;
    }

    useSessionStore.setState({
        permissions: state.permissions,
    });
});

useQuestionStore.subscribe((state, prevState) => {
    if (state.questions === prevState.questions) {
        return;
    }

    useSessionStore.setState({
        questions: state.questions,
    });
});

useDirectoryStore.subscribe((state, prevState) => {
    const nextDirectory = normalizePath(state.currentDirectory ?? null);
    const prevDirectory = normalizePath(prevState.currentDirectory ?? null);
    if (nextDirectory === prevDirectory) {
        return;
    }

    const draft = useSessionStore.getState().newSessionDraft;
    if (!draft?.open) {
        return;
    }

    const draftDirectory = normalizePath(draft.directoryOverride);
    if (draftDirectory && draftDirectory !== prevDirectory) {
        return;
    }

    useSessionStore.setState((store) => ({
        newSessionDraft: {
            ...store.newSessionDraft,
            directoryOverride: nextDirectory,
            parentID: null,
        },
    }));
});

const bootDraftOpen = useSessionStore.getState().newSessionDraft?.open;

useSessionStore.setState({
    sessions: useSessionManagementStore.getState().sessions,
    currentSessionId: bootDraftOpen ? null : useSessionManagementStore.getState().currentSessionId,
    lastLoadedDirectory: useSessionManagementStore.getState().lastLoadedDirectory,
    isLoading: useSessionManagementStore.getState().isLoading,
    error: useSessionManagementStore.getState().error,
    webUICreatedSessions: useSessionManagementStore.getState().webUICreatedSessions,
    worktreeMetadata: useSessionManagementStore.getState().worktreeMetadata,
    availableWorktrees: useSessionManagementStore.getState().availableWorktrees,
    availableWorktreesByProject: useSessionManagementStore.getState().availableWorktreesByProject,
    messages: useMessageStore.getState().messages,
    sessionMemoryState: useMessageStore.getState().sessionMemoryState,
    messageStreamStates: useMessageStore.getState().messageStreamStates,
    sessionCompactionUntil: useMessageStore.getState().sessionCompactionUntil,
    sessionAbortFlags: useMessageStore.getState().sessionAbortFlags,
    streamingMessageIds: useMessageStore.getState().streamingMessageIds,
    abortControllers: useMessageStore.getState().abortControllers,
    lastUsedProvider: useMessageStore.getState().lastUsedProvider,
    isSyncing: useMessageStore.getState().isSyncing,
    permissions: usePermissionStore.getState().permissions,
    questions: useQuestionStore.getState().questions,
    attachedFiles: useFileStore.getState().attachedFiles,
    sessionModelSelections: useContextStore.getState().sessionModelSelections,
    sessionAgentSelections: useContextStore.getState().sessionAgentSelections,
    sessionAgentModelSelections: useContextStore.getState().sessionAgentModelSelections,
    currentAgentContext: useContextStore.getState().currentAgentContext,
    sessionContextUsage: useContextStore.getState().sessionContextUsage,
    sessionAgentEditModes: useContextStore.getState().sessionAgentEditModes,
    abortPromptSessionId: null,
    abortPromptExpiresAt: null,
});

if (typeof window !== "undefined") {
    window.__zustand_session_store__ = useSessionStore;
}
