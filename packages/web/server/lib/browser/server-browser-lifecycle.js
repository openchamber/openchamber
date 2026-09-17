// Server browser (server-hosted Chrome) enabled-state lifecycle.
//
// Owns the single `serverBrowserEnabled` flag the backend router and the
// surface gateway read — never the settings file directly. Enabling only arms
// lazy construction: no browser module is composed (and no Chrome spawned)
// until the first routed request. Disabling takes effect immediately: the
// gateway is disposed (new upgrades rejected, connected viewers closed), the
// Chrome process generation is bumped (cancelling any in-flight startup) and
// a running Chrome is killed, and every session is ended (closing its policy
// proxy listener). The same teardown backs the server's graceful shutdown.
//
// This module imports nothing from the browser stack itself; the composition
// (with its lazy `import()`s) is injected, so a disabled flag keeps the
// chrome-process/session-manager/backend modules out of the module graph.

export const discoverActiveTunnelHost = (server, hostname) => {
  const address = server?.address?.();
  if (!hostname || !address || typeof address === 'string' || !Number.isInteger(address.port) || address.port < 1) return [];
  return [{ hostname, port: address.port }];
};

/**
 * @param {{
 *   compose: () => Promise<{
 *     chromeProcessManager: { kill: () => Promise<void>, shutdown: () => Promise<void>, getPrivatePorts: () => Promise<number[]>, activePort: number | null, launchDebugPort: number | null },
 *     browserSessionManager: { close: () => Promise<void> },
 *     backend: unknown,
 *   }>,
 *   disposeGateway?: () => void | Promise<void>,
 *   logger?: Pick<Console, 'warn'>,
 * }} dependencies
 */
export const createServerBrowserLifecycle = ({ compose, disposeGateway, logger = console }) => {
  const state = { enabled: false };
  let compositionPromise = null;
  let teardownPromise = null;
  let configuredPort = 0;

  const isEnabled = () => state.enabled === true;

  const setDebugPort = (port) => {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error('Chrome debugging port must be an integer from 0 to 65535');
    }
    configuredPort = port;
  };

  const getRuntimeStatus = async () => {
    const captured = compositionPromise;
    const composition = captured ? await captured : null;
    const manager = captured === compositionPromise ? composition?.chromeProcessManager : null;
    const activePort = manager?.activePort ?? null;
    const launchPort = manager?.launchDebugPort ?? null;
    return {
      configuredPort,
      running: activePort !== null,
      activePort,
      restartRequired: launchPort !== null && launchPort !== configuredPort,
    };
  };

  const getPrivatePorts = async () => {
    // The composition slot clears before Chrome finishes shutting down.
    if (teardownPromise) await teardownPromise;
    const composition = compositionPromise ? await compositionPromise : null;
    const ports = composition ? await composition.chromeProcessManager.getPrivatePorts() : [];
    return configuredPort > 0 ? [...ports, configuredPort] : ports;
  };

  // Lazy composition entry point for the router/gateway. Rejects honestly
  // while disabled so no caller can reach the backend around the flag.
  const ensureComposition = () => {
    if (!isEnabled()) {
      return Promise.reject(new Error('The server browser is disabled. Enable serverBrowserEnabled to use it.'));
    }
    compositionPromise ??= compose();
    return compositionPromise;
  };

  // Runs `load(composition)` only while enabled, and only delivers the loaded
  // value if the composition is still current when the load settles — a
  // disable (or a disable+re-enable cycle) mid-load disposes the loaded value
  // and yields null instead of leaving a half-live consumer bound to a
  // torn-down composition. Used by the surface gateway so it always receives
  // the composed session manager, never null, while enabled.
  const composeWhileEnabled = async (load, disposeLoaded) => {
    if (!isEnabled()) return null;
    const composition = await ensureComposition();
    const loaded = await load(composition);
    if (!loaded) return null;
    if (isEnabled()) {
      const current = await ensureComposition().catch(() => null);
      if (current === composition) return loaded;
    }
    try {
      await disposeLoaded?.(loaded);
    } catch (error) {
      logger.warn('[server-browser] Failed to dispose a stale composed consumer:', error?.message ?? error);
    }
    return null;
  };

  const teardown = async () => {
    try {
      await disposeGateway?.();
    } catch (error) {
      logger.warn('[server-browser] Failed to dispose the surface gateway:', error?.message ?? error);
    }
    const captured = compositionPromise;
    if (!captured) return;
    // Only clear the slot if it still holds the composition we are tearing
    // down — a re-enable may already have composed a fresh one.
    if (compositionPromise === captured) compositionPromise = null;
    const composition = await captured.catch(() => null);
    if (!composition) return;
    // kill() bumps the process generation first, so an in-flight startup on
    // the older generation is cancelled and never completes.
    try {
      await composition.chromeProcessManager.kill();
    } catch (error) {
      logger.warn('[server-browser] Failed to stop Chrome:', error?.message ?? error);
    }
    try {
      await composition.browserSessionManager.close();
    } catch (error) {
      logger.warn('[server-browser] Failed to close browser sessions:', error?.message ?? error);
    }
  };

  const apply = async (enabled) => {
    const next = enabled === true;
    if (state.enabled === next) return;
    // A re-enable must wait for any in-flight teardown so the stale
    // composition is gone before new work is routed.
    if (teardownPromise) await teardownPromise;
    state.enabled = next;
    if (next) return; // lazy arm; nothing composes until the first routed request
    teardownPromise = teardown();
    await teardownPromise;
  };

  // Graceful-shutdown entry: identical teardown, regardless of the flag, so a
  // running Chrome never outlives the server.
  const shutdown = () => {
    teardownPromise = teardown();
    return teardownPromise;
  };

  return {
    state, isEnabled, ensureComposition, composeWhileEnabled, apply, shutdown,
    setDebugPort, getDebugPort: () => configuredPort, getRuntimeStatus, getPrivatePorts,
  };
};
