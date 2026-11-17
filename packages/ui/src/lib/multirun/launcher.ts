export const RUN_LAUNCHER_ID = globalThis.crypto?.randomUUID?.()
  ?? `launcher_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
