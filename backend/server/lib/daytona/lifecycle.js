// Daytona sandbox lifecycle management.
//
// Uses the @daytona/sdk to create, monitor, and destroy sandboxes.
// Each chat session gets its own isolated sandbox with OpenCode running
// inside. The sandbox image comes pre-configured with OpenCode installed.

import { Daytona } from '@daytona/sdk';

/**
 * @param {{
 *   config: { apiKey: string, apiUrl: string, sandboxImage: string, openCodePort?: number },
 *   registry: import('./sandbox-registry.js').ReturnType<typeof import('./sandbox-registry.js').createSandboxRegistry>,
 *   logger?: Pick<Console, 'log' | 'warn' | 'error'>,
 * }} dependencies
 */
export const createDaytonaSandboxLifecycle = ({ config, registry, logger = console }) => {
  let daytonaClient = null;
  const openCodePort = config.openCodePort || 4096;

  const getClient = () => {
    if (!daytonaClient) {
      daytonaClient = new Daytona({
        apiKey: config.apiKey,
        apiUrl: config.apiUrl,
      });
    }
    return daytonaClient;
  };

  /**
   * Create a new sandbox for the given chat session.
   * Provisions via Daytona SDK, waits until ready, and registers in the registry.
   *
   * @param {string} sessionId - Chat session identifier.
   * @returns {Promise<{ sandboxId: string, openCodeUrl: string }>}
   */
  const createSandbox = async (sessionId) => {
    const existing = registry.get(sessionId);
    if (existing) {
      logger.warn(`[Daytona] Sandbox already exists for session ${sessionId}, returning existing`);
      return { sandboxId: existing.sandboxId, openCodeUrl: existing.openCodeUrl };
    }

    logger.log(`[Daytona] Creating sandbox for session ${sessionId}...`);

    const client = getClient();

    const sandbox = await client.create({
      image: config.sandboxImage,
      labels: {
        'openchamber-session': sessionId,
      },
    });

    const sandboxId = sandbox.id;
    logger.log(`[Daytona] Sandbox ${sandboxId} created for session ${sessionId}`);

    // The sandbox image has OpenCode pre-installed and configured to listen
    // on the configured port (default 4096). Construct the URL to reach it.
    const openCodeUrl = `https://${sandboxId}-${openCodePort}.${new URL(config.apiUrl).hostname}`;

    registry.register(sessionId, {
      sandboxId,
      openCodeUrl,
    });

    logger.log(`[Daytona] Sandbox ${sandboxId} registered and ready for session ${sessionId}`);

    return { sandboxId, openCodeUrl };
  };

  /**
   * Destroy the sandbox for a chat session.
   *
   * @param {string} sessionId - Chat session identifier.
   * @returns {Promise<void>}
   */
  const destroySandbox = async (sessionId) => {
    const entry = registry.get(sessionId);
    if (!entry) {
      logger.warn(`[Daytona] No sandbox found for session ${sessionId}, nothing to destroy`);
      return;
    }

    const { sandboxId } = entry;
    logger.log(`[Daytona] Destroying sandbox ${sandboxId} for session ${sessionId}...`);

    registry.unregister(sessionId);

    try {
      const client = getClient();
      await client.delete(sandboxId);
      logger.log(`[Daytona] Sandbox ${sandboxId} destroyed successfully`);
    } catch (error) {
      logger.error(`[Daytona] Failed to destroy sandbox ${sandboxId}: ${error?.message ?? error}`);
    }
  };

  /**
   * Destroy all active sandboxes (used during server shutdown).
   *
   * @returns {Promise<void>}
   */
  const destroyAllSandboxes = async () => {
    const active = registry.listActive();
    if (active.length === 0) return;

    logger.log(`[Daytona] Destroying all ${active.length} active sandbox(es)...`);

    const results = await Promise.allSettled(
      active.map((entry) => destroySandbox(entry.sessionId))
    );

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      logger.warn(`[Daytona] ${failed.length} sandbox(es) failed to destroy during shutdown`);
    }
  };

  return {
    createSandbox,
    destroySandbox,
    destroyAllSandboxes,
  };
};
