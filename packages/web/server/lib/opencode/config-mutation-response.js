/**
 * Shared response shapes for OpenCode config mutations.
 *
 * OpenCode 2 watches every config source it reads — agents, commands, skills,
 * MCP servers, providers, instructions and the plugin list — and rebuilds them
 * when a file changes. A mutation that lands on disk is therefore already live
 * by the time the route answers, so config mutations report plain success.
 *
 * Only changes OpenChamber cannot hand to a running process still ask for a
 * restart: the OpenCode binary, its port, and switching between managed and
 * external OpenCode. Those keep `buildExternalManualRestartResponse` and the
 * manual `POST /api/config/reload`.
 */

/**
 * `details` carries the file the mutation landed in (`{ path, scope, source }`).
 * OpenChamber never moves an entity between files, so the caller can show the
 * user exactly which config file changed — including a v1 file that was
 * rewritten in place in v2 shape.
 */
export function buildAppliedResponse(message, details) {
  return {
    success: true,
    message,
    ...(details && typeof details === 'object' ? details : {}),
  };
}

export function buildExternalManualRestartResponse(message) {
  return {
    success: true,
    requiresReload: false,
    requiresManualRestart: true,
    message,
  };
}
