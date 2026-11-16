export const newMutationKey = (): string => globalThis.crypto?.randomUUID?.() ?? `source-board-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
