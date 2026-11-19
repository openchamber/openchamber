import { isIP } from 'node:net';
import { isString } from '../shared/object-guards.js';
import type {} from './dependency-contracts.js';

export interface OpenCodeEnvironmentFields {
  OPENCODE_PORT?: unknown;
  OPENCHAMBER_OPENCODE_PORT?: unknown;
  OPENCHAMBER_INTERNAL_PORT?: unknown;
  OPENCODE_HOST?: unknown;
  OPENCHAMBER_OPENCODE_HOSTNAME?: unknown;
  OPENCHAMBER_PROXY_TIMEOUT_MS?: unknown;
}
export interface OpenCodeEnvConfigOptions {
  env?: unknown;
  logger?: Pick<Console, 'warn' | 'error'> | null;
}
const hasEnvironmentFields = (value: unknown): value is OpenCodeEnvironmentFields => Boolean(value && typeof value === 'object');

const MAX_HOSTNAME_LENGTH = 253;
const HOSTNAME_LABEL_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const ALL_NUMERIC_DOTTED_RE = /^\d+(?:\.\d+)*$/;

export const isValidOpenCodeHostname = (value: unknown): value is string => {
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

export const resolveProxyRequestTimeoutMs = (env: Pick<OpenCodeEnvironmentFields, 'OPENCHAMBER_PROXY_TIMEOUT_MS'> = {}, logger: Pick<Console, 'warn'> | null = null) => {
  const raw = isString(env.OPENCHAMBER_PROXY_TIMEOUT_MS) ? env.OPENCHAMBER_PROXY_TIMEOUT_MS.trim() : '';
  if (!raw) return 4 * 60 * 1000;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 2147483647) return parsed;
  if (logger) {
    logger.warn(
      `[config] Ignoring OPENCHAMBER_PROXY_TIMEOUT_MS=${JSON.stringify(raw)}: `
      + 'must be an integer from 0 to 2147483647 milliseconds (0 removes the deadline); '
      + 'keeping the 4-minute default',
    );
  }
  return 4 * 60 * 1000;
};

export const resolveOpenCodeEnvConfig = (options: OpenCodeEnvConfigOptions = {}) => {
  const env = hasEnvironmentFields(options.env) ? options.env : {};
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
    const raw = isString(env.OPENCODE_HOST) ? env.OPENCODE_HOST.trim() : '';
    if (!raw) return null;

    const warnInvalidHost = (reason: string) => {
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
    const writtenPort = raw.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(?:\[[^\]]*\]|[^/?#:]*):(\d+)(?:[/?#]|$)/i)?.[1];
    const port = parseInt(url.port || writtenPort || '', 10);
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

  const effectivePort = configuredOpenCodeHost?.port ?? configuredOpenCodePort;

  const configuredOpenCodeHostname = (() => {
    const raw = env.OPENCHAMBER_OPENCODE_HOSTNAME;
    if (!isString(raw)) {
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
