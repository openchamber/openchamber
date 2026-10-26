/**
 * Shared response shape for OpenCode config mutations.
 *
 * OpenCode 2 watches the config sources it reads and rebuilds agents,
 * commands, skills, MCP servers, providers and instructions when a file
 * changes, so a mutation that landed on disk is already live when the bridge
 * answers. Config mutations therefore report plain success; only the OpenCode
 * binary/port/external switches still need `api:config/reload`.
 */
/**
 * `details` carries the file the mutation landed in (`{ path, scope, source }`).
 * OpenChamber never moves an entity between files, so the caller can show the
 * user exactly which config file changed — including a v1 file that was
 * rewritten in place in v2 shape.
 */
export function buildAppliedResponse(message: string, details?: Record<string, unknown> | null) {
  return {
    success: true,
    message,
    ...(details && typeof details === 'object' ? details : {}),
  };
}
