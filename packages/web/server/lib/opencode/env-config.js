import { isIP } from 'node:net';

const MAX_HOSTNAME_LENGTH = 253;
const HOSTNAME_LABEL_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
// All-numeric dotted values must be a real IPv4 address; otherwise typo'd IPs
// like "0.0.0.0.0" would slip through as (technically valid) hostnames.
const ALL_NUMERIC_DOTTED_RE = /^\d+(?:\.\d+)*$/;

// Valid bind hostnames for the managed OpenCode server: IPv4, IPv6 (with or
// without brackets), or a DNS-style hostname. Everything else (URLs, ports,
// paths, whitespace, underscores) is rejected.
export const isValidOpenCodeHostname = (value) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_HOSTNAME_LENGTH) return false;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return isIP(trimmed.slice(1, -1)) === 6;
  }
  if (isIP(trimmed) !== 0) return true;
  if (ALL_NUMERIC_DOTTED_RE.test(trimmed)) return false;
  return trimmed.split('.').every((label) => HOSTNAME_LABEL_RE.test(label));
};

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
    if (!isValidOpenCodeHostname(trimmed)) {
      logger.error(
        `[config] Rejecting OPENCHAMBER_OPENCODE_HOSTNAME=${JSON.stringify(raw)}: `
        + 'must be a valid hostname or IP address (for example 127.0.0.1, 0.0.0.0, localhost, [::1]); '
        + 'falling back to 127.0.0.1 (loopback only)',
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
