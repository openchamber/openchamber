/**
 * Idempotent registration of the managed `openchamber-browser` MCP entry.
 *
 * Writes config DIRECTLY via the mcp.js helpers (NOT the /api/config/mcp route),
 * so it never triggers the route's unconditional OpenCode restart. Compares the
 * desired entry to what's on disk and only writes on drift; the caller decides
 * whether a single refresh/restart is warranted (only when something changed AND
 * OpenCode is already running). On stable reboots this is a pure no-op.
 *
 * The mcp config helpers are injected so this is unit-testable with fakes.
 */

export const MANAGED_BROWSER_MCP_NAME = 'openchamber-browser';
export const BROWSER_MCP_HTTP_PATH = '/openchamber-browser-mcp';

export const computeDesiredBrowserMcpEntry = ({ port, token }) => ({
  type: 'remote',
  url: `http://127.0.0.1:${port}${BROWSER_MCP_HTTP_PATH}`,
  headers: { Authorization: `Bearer ${token}` },
  enabled: true,
});

const entryMatches = (existing, desired) => {
  if (!existing) return false;
  if (existing.type !== desired.type) return false;
  if (existing.url !== desired.url) return false;
  if (existing.enabled !== desired.enabled) return false;
  const existingAuth = existing.headers && existing.headers.Authorization;
  const desiredAuth = desired.headers.Authorization;
  return existingAuth === desiredAuth;
};

/**
 * @returns {{ action: 'created'|'updated'|'deleted'|'noop', changed: boolean }}
 */
export const ensureBrowserMcpRegistration = ({ enabled, port, token, workingDirectory, mcp }) => {
  const { getMcpConfig, createMcpConfig, updateMcpConfig, deleteMcpConfig } = mcp || {};
  if (typeof getMcpConfig !== 'function') {
    throw new Error('ensureBrowserMcpRegistration requires mcp.getMcpConfig');
  }

  const existing = getMcpConfig(MANAGED_BROWSER_MCP_NAME, workingDirectory);

  if (!enabled || !port || !token) {
    if (existing) {
      deleteMcpConfig(MANAGED_BROWSER_MCP_NAME, workingDirectory);
      return { action: 'deleted', changed: true };
    }
    return { action: 'noop', changed: false };
  }

  const desired = computeDesiredBrowserMcpEntry({ port, token });

  if (!existing) {
    createMcpConfig(MANAGED_BROWSER_MCP_NAME, desired, workingDirectory);
    return { action: 'created', changed: true };
  }

  if (entryMatches(existing, desired)) {
    return { action: 'noop', changed: false };
  }

  updateMcpConfig(MANAGED_BROWSER_MCP_NAME, desired, workingDirectory);
  return { action: 'updated', changed: true };
};
