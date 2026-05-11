import { create } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import { DEFAULT_PREFIXES, DEFAULT_SYSTEM_PROMPTS, getPrefixPattern, type TaskType } from './taskPrompts.shared';

interface TaskPrefixState {
    prefixes: Record<TaskType, string>;
    systemPrompts: Record<TaskType, string>;
    setPrefix: (task: TaskType, prefix: string) => void;
    resetPrefix: (task: TaskType) => void;
    setSystemPrompt: (task: TaskType, prompt: string) => void;
    resetSystemPrompt: (task: TaskType) => void;
    resetAll: () => void;
    getPrefix: (task: TaskType) => string;
    getSystemPrompt: (task: TaskType, toolName: string) => string;
    getPattern: () => RegExp;
}

export type { TaskType } from "./taskPrompts.shared"

export const useTaskPrefixStore = create<TaskPrefixState>()(
    devtools(
        persist(
            (set, get) => ({
                prefixes: { ...DEFAULT_PREFIXES },
                systemPrompts: { ...DEFAULT_SYSTEM_PROMPTS },

                setPrefix: (task, prefix) =>
                    set((state) => ({
                        prefixes: { ...state.prefixes, [task]: prefix },
                    })),

                resetPrefix: (task) =>
                    set((state) => ({
                        prefixes: { ...state.prefixes, [task]: DEFAULT_PREFIXES[task] },
                    })),

                setSystemPrompt: (task, prompt) =>
                    set((state) => ({
                        systemPrompts: { ...state.systemPrompts, [task]: prompt },
                    })),

                resetSystemPrompt: (task) =>
                    set((state) => ({
                        systemPrompts: { ...state.systemPrompts, [task]: DEFAULT_SYSTEM_PROMPTS[task] },
                    })),

                resetAll: () =>
                    set({ prefixes: { ...DEFAULT_PREFIXES }, systemPrompts: { ...DEFAULT_SYSTEM_PROMPTS } }),

                getPrefix: (task) => get().prefixes[task],

                getSystemPrompt: (task, toolName) =>
                    get().systemPrompts[task].replace(/\{toolName\}/g, toolName),

                getPattern: () => getPrefixPattern(),
            }),
            {
                name: 'task-prefixes',
                storage: createJSONStorage(() => localStorage),
            }
        )
    )
);
