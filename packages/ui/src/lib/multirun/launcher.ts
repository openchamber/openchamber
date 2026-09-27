/**
 * Identifies this page. A run launched here records it with its auto-fusion
 * config, and only this page starts that fusion, exactly once. Another client
 * or a reload shows "Fuse now" in the overview instead of racing to start a
 * second fusion.
 */
export const RUN_LAUNCHER_ID = crypto.randomUUID();
