/**
 * Whether agent workflows exist at all in this build.
 *
 * Workflows ship dark while they are tested and improved against real work:
 * with the flag unset there is no tool, no routes, no settings row and no
 * session guidance, the way agent memory ships (../agent-memory/feature-flag.js).
 *
 * Read per call rather than captured at import, so the environment of the
 * running process is the only thing that decides.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export const isWorkflowFeatureAvailable = () => {
  const raw = process.env.OPENCHAMBER_WORKFLOWS_ENABLE ?? '';
  return TRUTHY.has(raw.trim().toLowerCase());
};
