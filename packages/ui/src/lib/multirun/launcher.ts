/**
 * Identifies this page. A run launched here records it with its auto-fusion
 * config, and only this page starts that fusion, exactly once. Another client
 * or a reload shows "Fuse now" in the overview instead of racing to start a
 * second fusion.
 */
// This module evaluates during app bootstrap, and `randomUUID` only exists in a
// secure context: a plain-HTTP LAN origin does not expose it, so an unguarded
// call would blank the whole UI. The id only has to be unique per page, so the
// timestamp fallback is enough.
export const RUN_LAUNCHER_ID = globalThis.crypto?.randomUUID?.()
  ?? `launcher_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
