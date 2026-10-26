/**
 * Whether agent memory exists at all in this build.
 *
 * The feature is complete but not released: it ships dark so it can be tested
 * against real work without appearing to users who have not asked for it. With
 * the flag unset there is no tool, no routes, no session index and no settings
 * row — not a switch left in the off position, which would invite someone to
 * turn on something unannounced.
 *
 * Read per call rather than captured at import, so a process started with the
 * variable set is the only thing that decides — no build step bakes it in.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export const isAgentMemoryFeatureAvailable = () => {
  const raw = process.env.OPENCHAMBER_MEMORY_ENABLE;
  return typeof raw === 'string' && TRUTHY.has(raw.trim().toLowerCase());
};
