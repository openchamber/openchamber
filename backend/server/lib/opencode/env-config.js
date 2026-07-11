export const resolveOpenCodeEnvConfig = (options = {}) => {
  const env = options.env && typeof options.env === 'object' ? options.env : {};
  const logger = options.logger ?? console;

  const configuredOpenCodePort = (() => {
    const raw =
      env.OPENCODE_PORT ||
      env.OPENCHAMBER_OPENCODE_PORT ||
      env.OPENCHAMBER_INTERNAL_PORT;
    if (!raw) {
      return null;
    }
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  })();

  const configuredOpenCodeHost = (() => {
    const raw = typeof env.OPENCODE_HOST === 'string' ? env.OPENCODE_HOST.trim() : '';
    if (!raw) return null;

    const warnInvalidHost = (reason) => {
      logger.warn(`[config] Ignoring OPENCODE_HOST=${JSON.stringify(raw)}: ${reason}`);
    };

    let url;
    try {
      url = new URL(raw);
    } catch {
      warnInvalidHost('not a valid URL');
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      warnInvalidHost(`must use http or https scheme (got ${JSON.stringify(url.protocol)})`);
      return null;
    }
    const port = parseInt(url.port, 10);
    if (!Number.isFinite(port) || port <= 0) {
      warnInvalidHost('must include an explicit port (example: http://hostname:4096)');
      return null;
    }
    if (url.pathname !== '/' || url.search || url.hash) {
      warnInvalidHost('must not include path, query, or hash');
      return null;
    }
    return { origin: url.origin, port };
  })();

  // OPENCODE_HOST takes precedence over OPENCODE_PORT when both are set
  const effectivePort = configuredOpenCodeHost?.port ?? configuredOpenCodePort;

  const configuredOpenCodeHostname = (() => {
    const raw = env.OPENCHAMBER_OPENCODE_HOSTNAME;
    if (typeof raw !== 'string') {
      return '127.0.0.1';
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      logger.warn(
        `[config] Ignoring OPENCHAMBER_OPENCODE_HOSTNAME=${JSON.stringify(raw)}: empty after trimming`,
      );
      return '127.0.0.1';
    }
    return trimmed;
  })();

  return {
    configuredOpenCodePort,
    configuredOpenCodeHost,
    effectivePort,
    configuredOpenCodeHostname,
  };
};
