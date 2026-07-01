import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { canPrompt, select as clackSelect, text as clackText, cancel as clackCancel, isCancel as clackIsCancel } from '../cli-output.js';

const TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS = 30 * 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MIN_MS = 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MAX_MS = 24 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_DEFAULT_MS = 8 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_MIN_MS = 5 * 60 * 1000;
const TUNNEL_SESSION_TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const CONNECT_TTL_PICKER_OPTIONS = [
  { value: String(3 * 60 * 1000), label: '3m' },
  { value: String(TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS), label: '30m' },
  { value: String(2 * 60 * 60 * 1000), label: '2h' },
  { value: String(8 * 60 * 60 * 1000), label: '8h' },
  { value: String(24 * 60 * 60 * 1000), label: '24h' },
  { value: '__custom__', label: 'Custom' },
];
const SESSION_TTL_PICKER_OPTIONS = [
  { value: String(60 * 60 * 1000), label: '1h' },
  { value: String(TUNNEL_SESSION_TTL_DEFAULT_MS), label: '8h' },
  { value: String(12 * 60 * 60 * 1000), label: '12h' },
  { value: String(24 * 60 * 60 * 1000), label: '24h' },
  { value: String(7 * 24 * 60 * 60 * 1000), label: '1w' },
  { value: String(30 * 24 * 60 * 60 * 1000), label: '30d' },
  { value: '__custom__', label: 'Custom' },
];

function parseHumanDurationToMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  const normalized = trimmed.replace(/\s+/g, '');
  const pattern = /(\d+)(ms|s|m|h|d)/g;
  let cursor = 0;
  let total = 0;
  let match;
  while ((match = pattern.exec(normalized)) !== null) {
    if (match.index !== cursor) {
      return null;
    }
    cursor = pattern.lastIndex;
    const amount = Number.parseInt(match[1], 10);
    const unit = match[2];
    const unitMs = unit === 'ms'
      ? 1
      : unit === 's'
        ? 1000
        : unit === 'm'
          ? 60 * 1000
          : unit === 'h'
            ? 60 * 60 * 1000
            : 24 * 60 * 60 * 1000;
    total += amount * unitMs;
  }

  if (cursor !== normalized.length) {
    return null;
  }

  return total;
}

function parseTtlMsOrThrow(rawValue, {
  flagName,
  minMs,
  maxMs,
} = {}) {
  const parsed = parseHumanDurationToMs(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new TunnelCliError(
      `Invalid value for ${flagName}. Use a positive duration like 30m, 24h, 1d, or milliseconds.`,
      EXIT_CODE.USAGE_ERROR,
    );
  }
  if (parsed < minMs || parsed > maxMs) {
    throw new TunnelCliError(
      `${flagName} must be between ${minMs}ms and ${maxMs}ms.`,
      EXIT_CODE.USAGE_ERROR,
    );
  }
  return parsed;
}

function formatDurationForCli(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  const value = Math.round(ms);
  if (value % (24 * 60 * 60 * 1000) === 0) return `${value / (24 * 60 * 60 * 1000)}d`;
  if (value % (60 * 60 * 1000) === 0) return `${value / (60 * 60 * 1000)}h`;
  if (value % (60 * 1000) === 0) return `${value / (60 * 1000)}m`;
  if (value % 1000 === 0) return `${value / 1000}s`;
  return `${value}ms`;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9._\-/:=]+$/.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function buildTunnelStartReplayCommand({
  port,
  provider,
  mode,
  profileName,
  configPath,
  hostname,
  connectTtlMs,
  sessionTtlMs,
  qr,
  noQr,
  includeTokenPlaceholder,
  tokenViaStdin,
  tokenFileProvided,
}) {
  const parts = ['openchamber', 'tunnel', 'start'];
  if (Number.isFinite(port) && port > 0) {
    parts.push('--port', String(port));
  }
  if (profileName) {
    parts.push('--profile', shellQuote(profileName));
  }
  if (provider) {
    parts.push('--provider', shellQuote(provider));
  }
  if (mode) {
    parts.push('--mode', shellQuote(mode));
  }
  if (typeof configPath === 'string' && configPath.trim().length > 0) {
    parts.push('--config', shellQuote(configPath));
  }
  if (typeof hostname === 'string' && hostname.trim().length > 0) {
    parts.push('--hostname', shellQuote(hostname));
  }
  const connectTtl = formatDurationForCli(connectTtlMs);
  if (connectTtl) {
    parts.push('--connect-ttl', connectTtl);
  }
  const sessionTtl = formatDurationForCli(sessionTtlMs);
  if (sessionTtl) {
    parts.push('--session-ttl', sessionTtl);
  }
  if (qr) parts.push('--qr');
  if (noQr) parts.push('--no-qr');

  if (includeTokenPlaceholder) {
    if (tokenViaStdin) {
      parts.push('--token-stdin');
    } else if (tokenFileProvided) {
      parts.push('--token-file', '<redacted>');
    } else {
      parts.push('--token', '<redacted>');
    }
  }

  return parts.join(' ');
}

function buildTunnelProfileAddCommand({ provider, hostname }) {
  const parts = [
    'openchamber',
    'tunnel',
    'profile',
    'add',
    '--provider',
    shellQuote(provider || 'cloudflare'),
    '--mode',
    'managed-remote',
    '--name',
    '<name>',
    '--hostname',
    shellQuote(hostname || '<hostname>'),
    '--token',
    '<token>',
  ];
  return parts.join(' ');
}

async function resolveTunnelTtlOverrides(options) {
  let connectTtlRaw = typeof options.connectTtl === 'string' ? options.connectTtl : undefined;
  let sessionTtlRaw = typeof options.sessionTtl === 'string' ? options.sessionTtl : undefined;

  const shouldPrompt = !connectTtlRaw
    && !sessionTtlRaw
    && canPrompt(options);

  if (shouldPrompt) {
    const connectChoice = await clackSelect({
      message: 'Select connect-link TTL',
      options: CONNECT_TTL_PICKER_OPTIONS,
    });
    if (clackIsCancel(connectChoice)) {
      clackCancel('Tunnel start cancelled.');
      return null;
    }
    if (connectChoice === '__custom__') {
      const enteredConnect = await clackText({
        message: 'Enter connect-link TTL (e.g. 30m, 2h, 1d)',
        placeholder: '30m',
        validate(value) {
          try {
            parseTtlMsOrThrow(value, {
              flagName: '--connect-ttl',
              minMs: TUNNEL_BOOTSTRAP_TTL_MIN_MS,
              maxMs: TUNNEL_BOOTSTRAP_TTL_MAX_MS,
            });
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : 'Invalid TTL value';
          }
        },
      });
      if (clackIsCancel(enteredConnect)) {
        clackCancel('Tunnel start cancelled.');
        return null;
      }
      connectTtlRaw = enteredConnect.trim();
    } else {
      connectTtlRaw = connectChoice;
    }

    const sessionChoice = await clackSelect({
      message: 'Select session TTL',
      options: SESSION_TTL_PICKER_OPTIONS,
    });
    if (clackIsCancel(sessionChoice)) {
      clackCancel('Tunnel start cancelled.');
      return null;
    }
    if (sessionChoice === '__custom__') {
      const enteredSession = await clackText({
        message: 'Enter session TTL (e.g. 8h, 24h, 1d)',
        placeholder: '8h',
        validate(value) {
          try {
            parseTtlMsOrThrow(value, {
              flagName: '--session-ttl',
              minMs: TUNNEL_SESSION_TTL_MIN_MS,
              maxMs: TUNNEL_SESSION_TTL_MAX_MS,
            });
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : 'Invalid TTL value';
          }
        },
      });
      if (clackIsCancel(enteredSession)) {
        clackCancel('Tunnel start cancelled.');
        return null;
      }
      sessionTtlRaw = enteredSession.trim();
    } else {
      sessionTtlRaw = sessionChoice;
    }
  }

  const connectTtlMs = connectTtlRaw !== undefined
    ? parseTtlMsOrThrow(connectTtlRaw, {
      flagName: '--connect-ttl',
      minMs: TUNNEL_BOOTSTRAP_TTL_MIN_MS,
      maxMs: TUNNEL_BOOTSTRAP_TTL_MAX_MS,
    })
    : undefined;

  const sessionTtlMs = sessionTtlRaw !== undefined
    ? parseTtlMsOrThrow(sessionTtlRaw, {
      flagName: '--session-ttl',
      minMs: TUNNEL_SESSION_TTL_MIN_MS,
      maxMs: TUNNEL_SESSION_TTL_MAX_MS,
    })
    : undefined;

  return {
    connectTtlMs,
    sessionTtlMs,
  };
}


export {
  buildTunnelStartReplayCommand,
  buildTunnelProfileAddCommand,
  resolveTunnelTtlOverrides,
};
