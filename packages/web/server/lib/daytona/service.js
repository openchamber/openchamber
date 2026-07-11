// Daytona sandbox orchestration service.
//
// Thin entrypoint that composes configuration, registry, lifecycle,
// inactivity monitor, and WebSocket bridge into a single service object.
// Follows the createXxxService() factory pattern used by other server modules.

import { resolveDaytonaConfig } from './config.js';
import { createSandboxRegistry } from './sandbox-registry.js';
import { createDaytonaSandboxLifecycle } from './lifecycle.js';
import { createInactivityMonitor } from './inactivity-monitor.js';
import { createWsBridge } from './ws-bridge.js';

/**
 * @param {{
 *   logger?: Pick<Console, 'log' | 'warn' | 'error'>,
 *   onSandboxTimeout?: (sessionId: string, sandboxId: string) => void,
 * }} [dependencies]
 *
 * @returns {{
 *   config: ReturnType<typeof resolveDaytonaConfig>,
 *   registry: ReturnType<typeof createSandboxRegistry>,
 *   lifecycle: ReturnType<typeof createDaytonaSandboxLifecycle>,
 *   monitor: ReturnType<typeof createInactivityMonitor>,
 *   bridge: ReturnType<typeof createWsBridge>,
 *   isEnabled: () => boolean,
 *   dispose: () => Promise<void>,
 * }}
 */
export const createDaytonaService = ({ logger = console, onSandboxTimeout } = {}) => {
  const config = resolveDaytonaConfig();
  const registry = createSandboxRegistry();

  const lifecycle = createDaytonaSandboxLifecycle({
    config,
    registry,
    logger,
  });

  const monitor = createInactivityMonitor({
    registry,
    lifecycle,
    config,
    logger,
    onTimeout: onSandboxTimeout,
  });

  const bridge = createWsBridge({ logger });

  /**
   * Whether the Daytona service is enabled (API key is configured).
   */
  const isEnabled = () => config.enabled;

  /**
   * Graceful shutdown: stop the monitor, disconnect all bridges,
   * and destroy all active sandboxes.
   */
  const dispose = async () => {
    monitor.dispose();

    // Disconnect all active bridges
    const all = registry.getAll();
    for (const [sessionId] of all) {
      bridge.disconnect(sessionId);
    }

    // Destroy all sandboxes
    await lifecycle.destroyAllSandboxes();

    logger.log('[Daytona] Service disposed');
  };

  return {
    config,
    registry,
    lifecycle,
    monitor,
    bridge,
    isEnabled,
    dispose,
  };
};
