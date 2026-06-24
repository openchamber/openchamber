import { create } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import { getSafeStorage } from './utils/safeStorage';
import type { AttachedFile } from './types/sessionTypes';
import { updateDesktopSettings } from '@/lib/persistence';

export type FollowUpBehavior = 'steer' | 'queue' | 'immediate';

export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = 'queue';

export const isFollowUpBehavior = (value: unknown): value is FollowUpBehavior => (
    value === 'steer' || value === 'queue' || value === 'immediate'
);

export const normalizeFollowUpBehavior = (
    value: unknown,
    legacyQueueModeEnabled?: boolean | null,
): FollowUpBehavior => {
    if (isFollowUpBehavior(value)) {
        return value;
    }

    if (legacyQueueModeEnabled === false) {
        return 'immediate';
    }

    if (legacyQueueModeEnabled === true) {
        return 'queue';
    }

    return DEFAULT_FOLLOW_UP_BEHAVIOR;
};

export interface QueuedMessage {
    id: string;
    content: string;
    attachments?: AttachedFile[];
    createdAt: number;
    /** Send config captured at queue time — used as-is when auto-sending */
    sendConfig?: {
        providerID: string;
        modelID: string;
        agent?: string;
        variant?: string;
    };
}

interface MessageQueueState {
    queuedMessages: Record<string, QueuedMessage[]>; // sessionId → queue
    followUpBehavior: FollowUpBehavior;
}

interface MessageQueueActions {
    addToQueue: (sessionId: string, message: Omit<QueuedMessage, 'id' | 'createdAt'>) => void;
    removeFromQueue: (sessionId: string, messageId: string) => void;
    popToInput: (sessionId: string, messageId: string) => QueuedMessage | null;
    clearQueue: (sessionId: string) => void;
    clearAllQueues: () => void;
    setFollowUpBehavior: (behavior: FollowUpBehavior) => void;
    getQueueForSession: (sessionId: string) => QueuedMessage[];
}

type MessageQueueStore = MessageQueueState & MessageQueueActions;

type PersistedMessageQueueState = {
    queuedMessages?: Record<string, QueuedMessage[]>;
    followUpBehavior?: FollowUpBehavior;
    queueModeEnabled?: boolean;
};

export const useMessageQueueStore = create<MessageQueueStore>()(
    devtools(
        persist(
            (set, get) => ({
                queuedMessages: {},
                followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,

                addToQueue: (sessionId, message) => {
                    const id = `queued-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                    const queuedMessage: QueuedMessage = {
                        id,
                        content: message.content,
                        attachments: message.attachments,
                        createdAt: Date.now(),
                        sendConfig: message.sendConfig,
                    };

                    set((state) => {
                        const currentQueue = state.queuedMessages[sessionId] ?? [];
                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [sessionId]: [...currentQueue, queuedMessage],
                            },
                        };
                    });
                },

                removeFromQueue: (sessionId, messageId) => {
                    set((state) => {
                        const currentQueue = state.queuedMessages[sessionId] ?? [];
                        const newQueue = currentQueue.filter((m) => m.id !== messageId);
                        
                        if (newQueue.length === 0) {
                            const { [sessionId]: _removed, ...rest } = state.queuedMessages;
                            void _removed;
                            return { queuedMessages: rest };
                        }
                        
                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [sessionId]: newQueue,
                            },
                        };
                    });
                },

                popToInput: (sessionId, messageId) => {
                    const state = get();
                    const currentQueue = state.queuedMessages[sessionId] ?? [];
                    const message = currentQueue.find((m) => m.id === messageId);
                    
                    if (!message) {
                        return null;
                    }

                    // Remove from queue
                    set((prevState) => {
                        const queue = prevState.queuedMessages[sessionId] ?? [];
                        const newQueue = queue.filter((m) => m.id !== messageId);
                        
                        if (newQueue.length === 0) {
                            const { [sessionId]: _removed, ...rest } = prevState.queuedMessages;
                            void _removed;
                            return { queuedMessages: rest };
                        }
                        
                        return {
                            queuedMessages: {
                                ...prevState.queuedMessages,
                                [sessionId]: newQueue,
                            },
                        };
                    });

                    return message;
                },

                clearQueue: (sessionId) => {
                    set((state) => {
                        const { [sessionId]: _removed, ...rest } = state.queuedMessages;
                        void _removed;
                        return { queuedMessages: rest };
                    });
                },

                clearAllQueues: () => {
                    set({ queuedMessages: {} });
                },

                setFollowUpBehavior: (behavior) => {
                    set({ followUpBehavior: behavior });
                    void updateDesktopSettings({ followUpBehavior: behavior });
                },

                getQueueForSession: (sessionId) => {
                    return get().queuedMessages[sessionId] ?? [];
                },
            }),
            {
                name: 'message-queue-store',
                version: 1,
                storage: createJSONStorage(() => getSafeStorage()),
                partialize: (state) => ({
                    queuedMessages: state.queuedMessages,
                    followUpBehavior: state.followUpBehavior,
                }),
                migrate: (persistedState) => {
                    const state = (persistedState ?? {}) as PersistedMessageQueueState;
                    return {
                        queuedMessages: state.queuedMessages ?? {},
                        followUpBehavior: normalizeFollowUpBehavior(state.followUpBehavior, state.queueModeEnabled ?? null),
                    };
                },
            }
        ),
        {
            name: 'message-queue-store',
        }
    )
);
