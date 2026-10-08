/** A fresh idempotency key per user action: a retry of the same click reuses it, a new click never does. */
export const newMutationKey = (): string => globalThis.crypto?.randomUUID?.() ?? `source-board-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
