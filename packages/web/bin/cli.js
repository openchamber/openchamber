#!/usr/bin/env node

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { isModuleCliExecution } from './cli-entry.js';
import { cloudflareTunnelProviderCapabilities } from '../server/lib/tunnels/providers/cloudflare.js';
import {
  intro as clackIntro, outro as clackOutro, log as clackLog,
  box as clackBox, confirm as clackConfirm,
  select as clackSelect, text as clackText, password as clackPassword, cancel as clackCancel,
  isCancel as clackIsCancel,
  isJsonMode,
  isQuietMode,
  shouldRenderHumanOutput,
  canPrompt,
  createSpinner,
  createProgress,
  printJson,
  logStatus, formatProviderWithIcon as clackFormatProviderWithIcon,
} from './cli-output.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PORT = 3000;
const DEFAULT_TAIL_LINES = 200;
const LOG_ROTATE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_ROTATE_KEEP = 5;
const TUNNEL_PROFILES_VERSION = 1;
const TUNNEL_PROFILES_FILE_NAME = 'tunnel-profiles.json';
const LEGACY_CLOUDFLARE_MANAGED_REMOTE_FILE_NAME = 'cloudflare-managed-remote-tunnels.json';
const TUNNEL_CLI_STATE_FILE_NAME = 'tunnel-cli-state.json';
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
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const DEFAULT_TUNNEL_PROVIDER_CAPABILITIES = [cloudflareTunnelProviderCapabilities];

let onCancelCleanup = null;
let activeCommandOptions = null;
let foregroundServerActive = false;
let foregroundShutdown = null;

function setCancelCleanup(handler) {
  onCancelCleanup = typeof handler === 'function' ? handler : null;
}

const HAS_PLAIN_FLAG = process.argv.includes('--plain');
const STYLE_ENABLED = process.stdout.isTTY && process.env.NO_COLOR !== '1' && !HAS_PLAIN_FLAG;
const ANSI = {
  bold: '\x1b[1m',
  unbold: '\x1b[22m',
};

// Browser-unsafe ports (Fetch/Chromium restricted ports).
const UNSAFE_BROWSER_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

const EXIT_CODE = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  USAGE_ERROR: 2,
  MISSING_DEPENDENCY: 3,
  AUTH_CONFIG_ERROR: 4,
  NETWORK_RUNTIME_ERROR: 5,
};

class TunnelCliError extends Error {
  constructor(message, exitCode = EXIT_CODE.GENERAL_ERROR) {
    super(message);
    this.name = 'TunnelCliError';
    this.exitCode = exitCode;
  }
}



function boldText(text) {
  if (!STYLE_ENABLED) return text;
  return `${ANSI.bold}${text}${ANSI.unbold}`;
}

function getDefaultCloudflaredConfigPath() {
  return path.join(os.homedir(), '.cloudflared', 'config.yml');
}

function isReadableRegularFile(filePath) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isUnsafeBrowserPort(port) {
  return Number.isFinite(port) && UNSAFE_BROWSER_PORTS.has(Math.trunc(port));
}

function resolveApiHost() {
  const configured = typeof process.env.OPENCHAMBER_HOST === 'string'
    ? process.env.OPENCHAMBER_HOST.trim()
    : '';

  if (!configured) {
    return '127.0.0.1';
  }

  // Wildcard bind hosts are not valid destination hosts.
  if (configured === '0.0.0.0') {
    return '127.0.0.1';
  }
  if (configured === '::' || configured === '[::]') {
    return '::1';
  }

  // Strip brackets if user provided [::1]
  if (configured.startsWith('[') && configured.endsWith(']')) {
    return configured.slice(1, -1);
  }

  return configured;
}

function formatHostForUrl(host) {
  if (typeof host !== 'string') return '127.0.0.1';
  // Bracket IPv6 for URL usage.
  return host.includes(':') ? `[${host}]` : host;
}

function buildLocalUrl(port, endpoint = '') {
  const host = formatHostForUrl(resolveApiHost());
  const pathPart = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `http://${host}:${port}${pathPart}`;
}

function formatUnsafePortWarning(port) {
  return `Port ${port} is browser-unsafe (ERR_UNSAFE_PORT) and is not supported for OpenChamber UI at ${buildLocalUrl(port, '/')}.`;
}

function assertSafeBrowserPort(port, { context = 'This action' } = {}) {
  if (!isUnsafeBrowserPort(port)) {
    return;
  }
  throw new TunnelCliError(
    `${context} cannot use port ${port}. ${formatUnsafePortWarning(port)} Use a safe port such as 3000, 5173, 8080, or a high ephemeral port.`,
    EXIT_CODE.USAGE_ERROR,
  );
}

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



function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function findClosestMatch(input, candidates, maxDistance = 3) {
  if (typeof input !== 'string' || input.length === 0 || !Array.isArray(candidates)) {
    return null;
  }
  const normalized = input.toLowerCase();
  let bestCandidate = null;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    const distance = levenshteinDistance(normalized, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCandidate = candidate;
    }
  }
  return bestDistance <= maxDistance ? bestCandidate : null;
}

function importFromFilePath(filePath) {
  return import(pathToFileURL(filePath).href);
}

function getBunBinary() {
  if (typeof process.env.BUN_BINARY === 'string' && process.env.BUN_BINARY.trim().length > 0) {
    return process.env.BUN_BINARY.trim();
  }
  if (typeof process.env.BUN_INSTALL === 'string' && process.env.BUN_INSTALL.trim().length > 0) {
    return path.join(process.env.BUN_INSTALL.trim(), 'bin', 'bun');
  }
  return 'bun';
}

function hasUiPasswordConfigured(password) {
  return typeof password === 'string' && password.trim().length > 0;
}

const BUN_BIN = getBunBinary();

function isBunRuntime() {
  return typeof globalThis.Bun !== 'undefined';
}

function isBunInstalled() {
  try {
    const result = spawnSync(BUN_BIN, ['--version'], {
      stdio: 'ignore',
      env: process.env,
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function getPreferredServerRuntime() {
  return isBunInstalled() ? 'bun' : 'node';
}

async function displayTunnelQrCode(url) {
  try {
    const qrcode = await import('qrcode-terminal');
    console.log('\n📱 Scan this QR code to access the tunnel:\n');
    qrcode.default.generate(url, { small: true });
    console.log('');
  } catch (error) {
    console.warn(`Warning: Could not generate QR code: ${error.message}`);
  }
}

function isTruthyEnv(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return normalized !== '0' && normalized !== 'false' && normalized !== 'no';
}

function shouldDisplayTunnelQr(options) {
  if (options?.json) return false;
  if (options?.quiet) return false;
  if (options?.explicitQr === true) return options.qr === true;
  if (!process.stdout?.isTTY) return false;
  return !isTruthyEnv(process.env.CI);
}

function splitOptionToken(arg) {
  if (!arg.startsWith('-')) return null;
  if (arg.startsWith('--')) {
    const eqIndex = arg.indexOf('=');
    return {
      name: eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2),
      inlineValue: eqIndex >= 0 ? arg.slice(eqIndex + 1) : undefined,
      long: true,
    };
  }
  return {
    name: arg.slice(1),
    inlineValue: undefined,
    long: false,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const options = {
    port: DEFAULT_PORT,
    host: undefined,
    uiPassword: process.env.OPENCHAMBER_UI_PASSWORD || undefined,
    json: false,
    all: false,
    follow: true,
    lines: DEFAULT_TAIL_LINES,
    provider: undefined,
    mode: undefined,
    profile: undefined,
    name: undefined,
    configPath: undefined,
    token: undefined,
    tokenFile: undefined,
    tokenStdin: false,
    hostname: undefined,
    connectTtl: undefined,
    sessionTtl: undefined,
    qr: false,
    explicitQr: false,
    force: false,
    showSecrets: false,
    dryRun: false,
    plain: false,
    quiet: false,
    explicitPort: false,
    explicitUiPassword: false,
    foreground: false,
  };

  const removedFlagErrors = [];
  const positional = [];
  let helpRequested = false;
  let versionRequested = false;

  const consumeValue = (index, inlineValue) => {
    if (typeof inlineValue === 'string' && inlineValue.length > 0) {
      return { value: inlineValue, nextIndex: index };
    }
    const candidate = args[index + 1];
    if (typeof candidate === 'string' && !candidate.startsWith('-')) {
      return { value: candidate, nextIndex: index + 1 };
    }
    return { value: undefined, nextIndex: index };
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const parsedToken = splitOptionToken(arg);
    if (!parsedToken) {
      positional.push(arg);
      continue;
    }

    const { name, inlineValue, long } = parsedToken;
    switch (name) {
      case 'port':
      case 'p': {
        const { value: consumedValue, nextIndex: consumedIndex } = consumeValue(i, inlineValue);
        let value = consumedValue;
        let nextIndex = consumedIndex;

        // Support explicit negative numeric values like `-p -1` so we can report
        // a clear range validation error instead of "Unknown option".
        if (value === undefined && typeof inlineValue !== 'string') {
          const candidate = args[i + 1];
          if (typeof candidate === 'string' && /^-\d+$/.test(candidate)) {
            value = candidate;
            nextIndex = i + 1;
          }
        }

        i = nextIndex;

        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new TunnelCliError('Missing value for --port.', EXIT_CODE.USAGE_ERROR);
        }

        if (!/^-?\d+$/.test(value.trim())) {
          throw new TunnelCliError(`Invalid port value: ${value}`, EXIT_CODE.USAGE_ERROR);
        }

        const parsed = parseInt(value, 10);
        if (parsed < 1 || parsed > 65535) {
          throw new TunnelCliError(`Invalid port value: ${parsed}`, EXIT_CODE.USAGE_ERROR);
        }

        options.port = parsed;
        options.explicitPort = true;
        break;
      }
      case 'host': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new TunnelCliError('Missing value for --host.', EXIT_CODE.USAGE_ERROR);
        }
        options.host = value.trim();
        break;
      }
      case 'ui-password': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.uiPassword = typeof value === 'string' ? value : '';
        options.explicitUiPassword = true;
        break;
      }
      case 'provider': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.provider = typeof value === 'string' ? value : options.provider;
        break;
      }
      case 'mode': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.mode = typeof value === 'string' ? value : options.mode;
        break;
      }
      case 'profile': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.profile = typeof value === 'string' ? value : options.profile;
        break;
      }
      case 'name': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.name = typeof value === 'string' ? value : options.name;
        break;
      }
      case 'config': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.configPath = typeof value === 'string' ? value : null;
        break;
      }
      case 'token': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.token = typeof value === 'string' ? value : options.token;
        break;
      }
      case 'token-file': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.tokenFile = typeof value === 'string' ? value : options.tokenFile;
        break;
      }
      case 'token-stdin':
        options.tokenStdin = true;
        break;
      case 'hostname': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.hostname = typeof value === 'string' ? value : options.hostname;
        break;
      }
      case 'connect-ttl': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.connectTtl = typeof value === 'string' ? value : options.connectTtl;
        break;
      }
      case 'session-ttl': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.sessionTtl = typeof value === 'string' ? value : options.sessionTtl;
        break;
      }
      case 'json':
        options.json = true;
        break;
      case 'all':
        options.all = true;
        break;
      case 'no-follow':
        options.follow = false;
        break;
      case 'lines': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        const parsed = parseInt(value ?? '', 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          options.lines = parsed;
        }
        break;
      }
      case 'qr':
        options.qr = true;
        options.explicitQr = true;
        break;
      case 'no-qr':
        options.qr = false;
        options.explicitQr = true;
        break;
      case 'force':
        options.force = true;
        break;
      case 'show-secrets':
        options.showSecrets = true;
        break;
      case 'dry-run':
        options.dryRun = true;
        break;
      case 'plain':
        options.plain = true;
        break;
      case 'quiet':
      case 'q':
        options.quiet = true;
        break;
      case 'help':
      case 'h':
        helpRequested = true;
        break;
      case 'version':
      case 'v':
        versionRequested = true;
        break;
      case 'foreground':
      case 'no-daemon':
        options.foreground = true;
        break;
      case 'daemon':
      case 'd':
        removedFlagErrors.push('`--daemon` was removed. OpenChamber now always runs in daemon mode.');
        break;
      case 'try-cf-tunnel':
        removedFlagErrors.push('`--try-cf-tunnel` was removed. Use: openchamber tunnel start --provider cloudflare --mode quick');
        break;
      case 'tunnel-qr':
        removedFlagErrors.push('`--tunnel-qr` was removed. Use: openchamber tunnel start ... --qr');
        break;
      case 'tunnel-password-url':
        removedFlagErrors.push('`--tunnel-password-url` was removed. Use UI password auth directly after tunnel start.');
        break;
      case 'tunnel-provider':
      case 'tunnel-mode':
      case 'tunnel-config':
      case 'tunnel-token':
      case 'tunnel-hostname':
      case 'tunnel':
        removedFlagErrors.push(`\`--${name}\` was removed from top-level serve flow. Use: openchamber tunnel start ...`);
        break;
      default:
        if (!long && name.length === 1) {
          removedFlagErrors.push(`Unknown option: -${name}`);
        } else {
          removedFlagErrors.push(`Unknown option: --${name}`);
        }
        break;
    }
  }

  const command = positional[0] || 'serve';
  const subcommand = command === 'tunnel' ? (positional[1] || 'help') : null;
  const tunnelAction = command === 'tunnel' ? (positional[2] || null) : null;

  return {
    command,
    subcommand,
    tunnelAction,
    options,
    removedFlagErrors,
    helpRequested,
    versionRequested,
  };
}

function showHelp() {
  console.log(`
 OpenChamber - Web interface for the OpenCode AI coding agent

USAGE:
  openchamber [COMMAND] [OPTIONS]

COMMANDS:
  serve          Start the web server (daemon default)
  stop           Stop running instance(s)
  restart        Stop and start the server
  status         Show server status
  tunnel         Tunnel lifecycle commands
  logs           Tail OpenChamber logs
  update         Check for and install updates

OPTIONS:
  -p, --port              Web server port (default: ${DEFAULT_PORT})
  --host                  Bind address (default: 127.0.0.1)
  --ui-password           Protect browser UI with single password
  --foreground            Run server in foreground (use with systemd/process managers)
  --no-daemon             Alias for --foreground
  -h, --help              Show help
  -v, --version           Show version

ENVIRONMENT:
  OPENCHAMBER_HOST             Bind address (e.g. 0.0.0.0 for all interfaces)
  OPENCHAMBER_UI_PASSWORD      Alternative to --ui-password flag
  OPENCHAMBER_DATA_DIR         Override OpenChamber data directory
  OPENCODE_HOST               External OpenCode server base URL, e.g. http://hostname:4096
  OPENCODE_PORT               Port of external OpenCode server to connect to
  OPENCODE_SKIP_START          Skip starting OpenCode, use external server
  OPENCHAMBER_OPENCODE_HOSTNAME  Bind hostname for managed OpenCode server (default: 127.0.0.1)

EXAMPLES:
  openchamber                    # Start in daemon mode on default port 3000 (or free port)
  openchamber --port 8080        # Start on port 8080 (daemon)
  openchamber serve --foreground # Start in foreground (for systemd Type=simple)
  openchamber tunnel help        # Show tunnel lifecycle help
  openchamber logs               # Follow logs for latest running instance
`);
}

function showTunnelHelp() {
  console.log(`
 Tunnel Lifecycle Commands

USAGE:
  openchamber tunnel <SUBCOMMAND> [OPTIONS]

SUBCOMMANDS:
  help        Show this tunnel help
  providers   Show available tunnel providers and capabilities
  ready       Check tunnel readiness for a provider
  doctor      Run deep tunnel diagnostics
  status      Show tunnel status
  start       Start a tunnel
  stop        Stop active tunnel (keep server running)
  profile     Manage saved managed-remote profiles

COMMON OPTIONS:
  -p, --port              Target OpenChamber instance port
  --json                  Output machine-readable JSON
  --all                   Apply to all running instances (doctor default, stop)

START OPTIONS:
  --provider <id>         Tunnel provider id (default: cloudflare)
  --mode <id>             Tunnel mode (default: quick)
  --profile <name>        Start tunnel from saved profile name
  --config [path]         Managed-local config path (optional)
  --token <token>         Managed-remote token (visible in process list)
  --token-file <path>     Read token from file (recommended)
  --token-stdin           Read token from stdin
  --hostname <hostname>   Managed-remote hostname
  --connect-ttl <value>   Connect-link TTL (e.g. 30m, 24h, 1d)
  --session-ttl <value>   Session TTL (e.g. 8h, 24h, 1d)
  --qr                    Print QR code for resulting tunnel URL
  --no-qr                 Disable QR output
  --dry-run               Validate inputs without applying changes

OUTPUT OPTIONS:
  --show-secrets          Show full tokens in output (default: redacted)
  --plain                 Disable colors and decorations
  -q, --quiet             Suppress non-essential output
  --json                  Output machine-readable JSON

BEHAVIOR NOTES:
  - One active tunnel per OpenChamber instance.
  - Starting a different mode/provider replaces the current tunnel and revokes old connect links/sessions.
  - Connect links are one-time; generating a new link revokes the previous unused link.

PROFILE USAGE:
  openchamber tunnel profile list [--provider <id>] [--json]
  openchamber tunnel profile show --name <name> [--provider <id>] [--json]
  openchamber tunnel profile add --provider <id> --mode managed-remote --name <name> --hostname <host> --token <token> [--force] [--json]
  openchamber tunnel profile add --provider <id> --mode managed-remote --name <name> --hostname <host> --token-file <path> [--force] [--json]
  openchamber tunnel profile remove --name <name> [--provider <id>] [--json]

SHELL COMPLETION:
  openchamber tunnel completion bash   Generate Bash completion script
  openchamber tunnel completion zsh    Generate Zsh completion script
  openchamber tunnel completion fish   Generate Fish completion script

EXAMPLES:
  openchamber tunnel providers
  openchamber tunnel ready --provider cloudflare
  openchamber tunnel doctor --provider cloudflare
  openchamber tunnel status
  openchamber tunnel start --qr
  openchamber tunnel start --profile prod-main
  openchamber tunnel start --provider cloudflare --mode managed-remote --token-file ~/.secrets/cf-token --hostname app.example.com
  openchamber tunnel start --provider cloudflare --mode managed-local --config ~/.cloudflared/config.yml
  openchamber tunnel start --dry-run --provider cloudflare --mode managed-remote --token-file ~/.secrets/cf-token --hostname app.example.com
  echo "$TOKEN" | openchamber tunnel profile add --provider cloudflare --mode managed-remote --name prod-main --hostname app.example.com --token-stdin
  openchamber tunnel profile list --provider cloudflare
  openchamber tunnel profile list --json --show-secrets
  openchamber tunnel stop --port 3000
`);
}

function generateCompletionScript(shell) {
  const normalized = typeof shell === 'string' ? shell.trim().toLowerCase() : '';

  if (normalized === 'bash') {
    return `# Bash completion for openchamber tunnel
# Add to ~/.bashrc: eval "$(openchamber tunnel completion bash)"
_openchamber_tunnel() {
  local cur prev commands tunnel_commands profile_commands common_flags start_flags
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="serve stop restart status tunnel logs update"
  tunnel_commands="help providers ready doctor status start stop profile completion"
  profile_commands="list show add remove"
  common_flags="--port --foreground --no-daemon --json --all --help --version --plain --quiet"
  start_flags="--provider --mode --profile --config --token --token-file --token-stdin --hostname --connect-ttl --session-ttl --qr --no-qr --dry-run --show-secrets"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
    return 0
  fi

  if [[ "\${COMP_WORDS[1]}" == "tunnel" ]]; then
    if [[ \${COMP_CWORD} -eq 2 ]]; then
      COMPREPLY=( $(compgen -W "\${tunnel_commands}" -- "\${cur}") )
      return 0
    fi
    if [[ "\${COMP_WORDS[2]}" == "profile" && \${COMP_CWORD} -eq 3 ]]; then
      COMPREPLY=( $(compgen -W "\${profile_commands}" -- "\${cur}") )
      return 0
    fi
    if [[ "\${COMP_WORDS[2]}" == "completion" && \${COMP_CWORD} -eq 3 ]]; then
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") )
      return 0
    fi
    if [[ "\${COMP_WORDS[2]}" == "start" ]]; then
      COMPREPLY=( $(compgen -W "\${start_flags} \${common_flags}" -- "\${cur}") )
      return 0
    fi
    COMPREPLY=( $(compgen -W "\${common_flags}" -- "\${cur}") )
    return 0
  fi

  COMPREPLY=( $(compgen -W "\${common_flags}" -- "\${cur}") )
  return 0
}
complete -F _openchamber_tunnel openchamber
`;
  }

  if (normalized === 'zsh') {
    return `#compdef openchamber
# Zsh completion for openchamber tunnel
# Add to ~/.zshrc: eval "$(openchamber tunnel completion zsh)"

_openchamber() {
  local -a commands tunnel_commands profile_commands

  commands=(
    'serve:Start the web server'
    'stop:Stop running instance(s)'
    'restart:Stop and start the server'
    'status:Show server status'
    'tunnel:Tunnel lifecycle commands'
    'logs:Tail OpenChamber logs'
    'update:Check for and install updates'
  )

  tunnel_commands=(
    'help:Show tunnel help'
    'providers:Show available providers'
    'ready:Check tunnel readiness'
    'doctor:Run tunnel diagnostics'
    'status:Show tunnel status'
    'start:Start a tunnel'
    'stop:Stop active tunnel'
    'profile:Manage saved profiles'
    'completion:Generate shell completion'
  )

  profile_commands=(
    'list:List profiles'
    'show:Show profile details'
    'add:Add a profile'
    'remove:Remove a profile'
  )

  _arguments -C \\
    '1:command:->command' \\
    '*::arg:->args'

  case \$state in
    command)
      _describe 'command' commands
      ;;
    args)
      case \$words[1] in
        tunnel)
          if (( CURRENT == 2 )); then
            _describe 'tunnel command' tunnel_commands
          elif [[ \$words[2] == "profile" ]] && (( CURRENT == 3 )); then
            _describe 'profile action' profile_commands
          elif [[ \$words[2] == "completion" ]] && (( CURRENT == 3 )); then
            _values 'shell' bash zsh fish
          fi
          ;;
      esac
      ;;
  esac
}

compdef _openchamber openchamber
`;
  }

  if (normalized === 'fish') {
    return `# Fish completion for openchamber tunnel
# Save to ~/.config/fish/completions/openchamber.fish

complete -c openchamber -n '__fish_use_subcommand' -a 'serve' -d 'Start the web server'
complete -c openchamber -n '__fish_seen_subcommand_from serve' -l foreground -d 'Run in foreground (for systemd/process managers)'
complete -c openchamber -n '__fish_seen_subcommand_from serve' -l no-daemon -d 'Run in foreground (alias for --foreground)'
complete -c openchamber -n '__fish_use_subcommand' -a 'stop' -d 'Stop running instance(s)'
complete -c openchamber -n '__fish_use_subcommand' -a 'restart' -d 'Stop and start the server'
complete -c openchamber -n '__fish_use_subcommand' -a 'status' -d 'Show server status'
complete -c openchamber -n '__fish_use_subcommand' -a 'tunnel' -d 'Tunnel lifecycle commands'
complete -c openchamber -n '__fish_use_subcommand' -a 'logs' -d 'Tail logs'
complete -c openchamber -n '__fish_use_subcommand' -a 'update' -d 'Check for updates'

complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'help' -d 'Show tunnel help'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'providers' -d 'Show providers'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'ready' -d 'Check readiness'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'doctor' -d 'Run diagnostics'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'status' -d 'Show tunnel status'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'start' -d 'Start a tunnel'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'stop' -d 'Stop tunnel'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'profile' -d 'Manage profiles'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'completion' -d 'Generate completions'

complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l provider -d 'Provider id'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l mode -d 'Tunnel mode'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l profile -d 'Profile name'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l config -d 'Config path'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l token -d 'Token'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l token-file -d 'Token file path'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l token-stdin -d 'Read token from stdin'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l hostname -d 'Hostname'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l dry-run -d 'Validate without applying'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l qr -d 'Show QR code'
`;
  }

  return null;
}

function getDataDir() {
  if (typeof process.env.OPENCHAMBER_DATA_DIR === 'string' && process.env.OPENCHAMBER_DATA_DIR.trim().length > 0) {
    return path.resolve(process.env.OPENCHAMBER_DATA_DIR.trim());
  }
  return path.join(os.homedir(), '.config', 'openchamber');
}

function getLogsDir() {
  return path.join(getDataDir(), 'logs');
}

function getSettingsFilePath() {
  return path.join(getDataDir(), 'settings.json');
}

function readDesktopLocalPortFromSettings() {
  try {
    const raw = fs.readFileSync(getSettingsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    const value = parsed?.desktopLocalPort;
    if (Number.isFinite(value) && value > 0 && value <= 65535) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

function ensureLogsDir() {
  fs.mkdirSync(getLogsDir(), { recursive: true });
}

function getLogFilePath(port) {
  return path.join(getLogsDir(), `openchamber-${port}.log`);
}

function getTunnelProfilesFilePath() {
  return path.join(getDataDir(), TUNNEL_PROFILES_FILE_NAME);
}

function getLegacyCloudflareManagedRemoteFilePath() {
  return path.join(getDataDir(), LEGACY_CLOUDFLARE_MANAGED_REMOTE_FILE_NAME);
}

function getTunnelCliStateFilePath() {
  return path.join(getDataDir(), TUNNEL_CLI_STATE_FILE_NAME);
}

function readTunnelCliState() {
  const filePath = getTunnelCliStateFilePath();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function readLastManagedLocalConfigPath() {
  const state = readTunnelCliState();
  if (typeof state.lastManagedLocalConfigPath !== 'string') {
    return '';
  }
  return state.lastManagedLocalConfigPath.trim();
}

function writeLastManagedLocalConfigPath(configPath) {
  if (typeof configPath !== 'string' || configPath.trim().length === 0) {
    return;
  }
  const filePath = getTunnelCliStateFilePath();
  const current = readTunnelCliState();
  const next = {
    ...current,
    lastManagedLocalConfigPath: configPath.trim(),
    updatedAt: Date.now(),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
}

function normalizeProfileProvider(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function normalizeProfileMode(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function normalizeProfileName(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeProfileHostname(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeProfileToken(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function suggestProfileNameFromHostname(hostname) {
  const normalizedHost = normalizeProfileHostname(hostname);
  if (!normalizedHost) return 'prod-main';
  const firstLabel = normalizedHost.split('.')[0] || normalizedHost;
  const sanitized = firstLabel.replace(/[^a-zA-Z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return sanitized || 'prod-main';
}

function maskToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return '***';
  }
  if (token.length <= 4) {
    return '*'.repeat(token.length);
  }
  return `${'*'.repeat(Math.max(4, token.length - 4))}${token.slice(-4)}`;
}

const MAX_TOKEN_FILE_BYTES = 8 * 1024;

function readTokenFromFileSafely(tokenFilePath) {
  const absolutePath = path.resolve(tokenFilePath);
  let realPath;
  try {
    realPath = fs.realpathSync(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Token file '${absolutePath}' not found.`);
    }
    if (error?.code === 'EACCES') {
      throw new Error(`Token file '${absolutePath}' is not readable. Check file permissions.`);
    }
    throw error;
  }

  let stats;
  try {
    stats = fs.statSync(realPath);
  } catch (error) {
    if (error?.code === 'EACCES') {
      throw new Error(`Token file '${absolutePath}' is not readable. Check file permissions.`);
    }
    throw error;
  }

  if (!stats.isFile()) {
    throw new Error(`Token file '${absolutePath}' must be a regular file.`);
  }
  if (stats.size <= 0) {
    throw new Error(`Token file '${absolutePath}' is empty.`);
  }
  if (stats.size > MAX_TOKEN_FILE_BYTES) {
    throw new Error(`Token file '${absolutePath}' is too large (max ${MAX_TOKEN_FILE_BYTES} bytes).`);
  }

  const raw = fs.readFileSync(realPath, 'utf8');
  if (raw.includes('\u0000')) {
    throw new Error(`Token file '${absolutePath}' appears to be binary. Use a plain text token file.`);
  }

  const value = raw.trim();
  if (!value) {
    throw new Error(`Token file '${absolutePath}' is empty.`);
  }
  return value;
}

function resolveToken(options) {
  const sources = [
    options.tokenStdin ? 'stdin' : null,
    options.tokenFile ? 'file' : null,
    options.token ? 'flag' : null,
  ].filter(Boolean);

  if (sources.length > 1) {
    throw new Error(`Multiple token sources specified (${sources.join(', ')}). Use only one of --token, --token-file, or --token-stdin.`);
  }

  if (options.tokenStdin) {
    const fd = fs.openSync('/dev/stdin', 'r');
    try {
      const buf = Buffer.alloc(65536);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      const value = buf.slice(0, bytesRead).toString('utf8').trim();
      if (!value) {
        throw new Error('No token received from stdin.');
      }
      return value;
    } finally {
      fs.closeSync(fd);
    }
  }

  if (options.tokenFile) {
    return readTokenFromFileSafely(options.tokenFile);
  }

  return typeof options.token === 'string' ? options.token.trim() : undefined;
}

function redactProfileForOutput(profile, showSecrets = false) {
  if (!profile || typeof profile !== 'object') {
    return profile;
  }
  return {
    ...profile,
    token: showSecrets ? profile.token : maskToken(profile.token),
  };
}

function redactProfilesForOutput(profiles, showSecrets = false) {
  if (!Array.isArray(profiles)) {
    return profiles;
  }
  return profiles.map((entry) => redactProfileForOutput(entry, showSecrets));
}

function formatProfileTokenStatus(profile, showSecrets = false) {
  const token = typeof profile?.token === 'string' ? profile.token.trim() : '';
  if (!token) {
    return 'token:missing';
  }
  if (showSecrets) {
    return `token:${token}`;
  }
  return 'token:present';
}

function sanitizeTunnelProfilesData(data) {
  const parsed = data && typeof data === 'object' ? data : {};
  const list = Array.isArray(parsed.profiles) ? parsed.profiles : [];
  const seen = new Set();
  const profiles = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' && entry.id.trim().length > 0 ? entry.id.trim() : crypto.randomUUID();
    const provider = normalizeProfileProvider(entry.provider);
    const mode = normalizeProfileMode(entry.mode);
    const name = normalizeProfileName(entry.name);
    const hostname = normalizeProfileHostname(entry.hostname);
    const token = normalizeProfileToken(entry.token);
    if (!provider || !mode || !name || !hostname || !token) continue;
    const key = `${provider}::${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    profiles.push({
      id,
      name,
      provider,
      mode,
      hostname,
      token,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
      updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
    });
  }
  return { version: TUNNEL_PROFILES_VERSION, profiles };
}

function warnIfUnsafeFilePermissions(filePath) {
  if (process.platform === 'win32') {
    return;
  }
  if (isJsonMode(activeCommandOptions) || isQuietMode(activeCommandOptions)) {
    return;
  }
  try {
    const stats = fs.statSync(filePath);
    const perms = stats.mode & 0o777;
    if (perms & 0o077) {
      const octal = perms.toString(8).padStart(3, '0');
      console.warn(
        `Warning: Profile file '${filePath}' has permissions ${octal} (should be 600). ` +
        `Other users may be able to read tunnel tokens. Fix with: chmod 600 '${filePath}'`
      );
    }
  } catch {
    // File may not exist yet — not an error
  }
}

function readTunnelProfilesFromDisk() {
  const filePath = getTunnelProfilesFilePath();
  try {
    warnIfUnsafeFilePermissions(filePath);
    const raw = fs.readFileSync(filePath, 'utf8');
    return sanitizeTunnelProfilesData(JSON.parse(raw));
  } catch {
    return { version: TUNNEL_PROFILES_VERSION, profiles: [] };
  }
}

function writeTunnelProfilesToDisk(data) {
  const filePath = getTunnelProfilesFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(sanitizeTunnelProfilesData(data), null, 2), { encoding: 'utf8', mode: 0o600 });
}

function writeManagedRemotePairsToDiskFromProfiles(profilesData) {
  const profiles = sanitizeTunnelProfilesData(profilesData).profiles;
  const cloudflareManagedRemote = profiles.filter(
    (entry) => entry.provider === 'cloudflare' && entry.mode === 'managed-remote'
  );

  const tunnels = cloudflareManagedRemote.map((entry) => ({
    id: entry.id,
    name: entry.name,
    hostname: entry.hostname,
    token: entry.token,
    updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
  }));

  const filePath = getLegacyCloudflareManagedRemoteFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, tunnels }, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function readLegacyManagedRemoteEntries() {
  try {
    const raw = fs.readFileSync(getLegacyCloudflareManagedRemoteFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    const tunnels = Array.isArray(parsed?.tunnels) ? parsed.tunnels : [];
    return tunnels
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const id = typeof entry.id === 'string' && entry.id.trim().length > 0 ? entry.id.trim() : crypto.randomUUID();
        const name = normalizeProfileName(entry.name);
        const hostname = normalizeProfileHostname(entry.hostname);
        const token = normalizeProfileToken(entry.token);
        if (!name || !hostname || !token) return null;
        return {
          id,
          name,
          provider: 'cloudflare',
          mode: 'managed-remote',
          hostname,
          token,
          createdAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
          updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function makeUniqueProfileName(provider, desiredName, existingProfiles) {
  const normalizedDesired = normalizeProfileName(desiredName);
  if (!normalizedDesired) {
    return '';
  }
  const existingNames = new Set(
    existingProfiles
      .filter((entry) => entry.provider === provider)
      .map((entry) => entry.name.toLowerCase())
  );

  if (!existingNames.has(normalizedDesired.toLowerCase())) {
    return normalizedDesired;
  }

  let index = 2;
  while (true) {
    const candidate = `${normalizedDesired}-${index}`;
    if (!existingNames.has(candidate.toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
}

function ensureTunnelProfilesMigrated() {
  const current = readTunnelProfilesFromDisk();
  if (current.profiles.length > 0) {
    return current;
  }

  const legacyEntries = readLegacyManagedRemoteEntries();
  if (legacyEntries.length === 0) {
    return current;
  }

  const migratedProfiles = [];
  for (const entry of legacyEntries) {
    const name = makeUniqueProfileName(entry.provider, entry.name, migratedProfiles);
    migratedProfiles.push({ ...entry, name });
  }

  const migrated = sanitizeTunnelProfilesData({ version: TUNNEL_PROFILES_VERSION, profiles: migratedProfiles });
  writeTunnelProfilesToDisk(migrated);
  writeManagedRemotePairsToDiskFromProfiles(migrated);
  return migrated;
}

function resolveProfileByName(profiles, profileName, provider) {
  const normalizedName = normalizeProfileName(profileName).toLowerCase();
  const normalizedProvider = normalizeProfileProvider(provider);
  const matches = profiles.filter((entry) => {
    if (entry.name.toLowerCase() !== normalizedName) return false;
    if (!normalizedProvider) return true;
    return entry.provider === normalizedProvider;
  });

  if (matches.length === 0) {
    return { profile: null, error: `No tunnel profile found for name '${profileName}'. Run 'openchamber tunnel profile list'.` };
  }
  if (matches.length > 1) {
    return { profile: null, error: `Profile name '${profileName}' exists for multiple providers. Use --provider <id>.` };
  }
  return { profile: matches[0], error: null };
}

function rotateLogFile(logPath) {
  try {
    const stats = fs.statSync(logPath);
    if (stats.size < LOG_ROTATE_MAX_BYTES) {
      return;
    }
  } catch {
    return;
  }

  for (let i = LOG_ROTATE_KEEP - 1; i >= 1; i--) {
    const src = `${logPath}.${i}`;
    const dst = `${logPath}.${i + 1}`;
    if (fs.existsSync(src)) {
      try {
        fs.renameSync(src, dst);
      } catch {
      }
    }
  }

  try {
    if (fs.existsSync(logPath)) {
      fs.renameSync(logPath, `${logPath}.1`);
    }
  } catch {
  }
}

const WINDOWS_EXTENSIONS = process.platform === 'win32'
  ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean)
      .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
  : [''];

function isExecutable(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      return true;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExplicitBinary(candidate) {
  if (!candidate) {
    return null;
  }
  if (candidate.includes(path.sep) || path.isAbsolute(candidate)) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
    return isExecutable(resolved) ? resolved : null;
  }
  return null;
}

function searchPathFor(command) {
  const pathValue = process.env.PATH || '';
  const segments = pathValue.split(path.delimiter).filter(Boolean);
  for (const dir of segments) {
    for (const ext of WINDOWS_EXTENSIONS) {
      const fileName = process.platform === 'win32' ? `${command}${ext}` : command;
      const candidate = path.join(dir, fileName);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function checkOpenCodeCLI(onNotice) {
  if (process.env.OPENCODE_BINARY) {
    const override = resolveExplicitBinary(process.env.OPENCODE_BINARY);
    if (override) {
      process.env.OPENCODE_BINARY = override;
      return override;
    }
    const message = `OPENCODE_BINARY="${process.env.OPENCODE_BINARY}" is not an executable file. Falling back to PATH lookup.`;
    if (typeof onNotice === 'function') {
      onNotice({ level: 'warning', code: 'OPENCODE_BINARY_INVALID', message });
    } else {
      console.warn(`Warning: ${message}`);
    }
  }

  const resolvedFromPath = searchPathFor('opencode');
  if (resolvedFromPath) {
    process.env.OPENCODE_BINARY = resolvedFromPath;
    return resolvedFromPath;
  }

  throw new Error(
    `Unable to locate the opencode CLI on PATH (${process.env.PATH || '<empty>'}). ` +
    'Ensure the CLI is installed and reachable, or set OPENCODE_BINARY to its full path.'
  );
}

async function isPortAvailable(port, host) {
  if (!Number.isFinite(port) || port <= 0) {
    return false;
  }

  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen({ port, host }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function resolveAvailablePort(desiredPort, explicitPort = false, onNotice) {
  const startPort = Number.isFinite(desiredPort) ? Math.trunc(desiredPort) : DEFAULT_PORT;
  if (explicitPort) {
    return startPort;
  }
  if (await isPortAvailable(startPort)) {
    return startPort;
  }

  const occupant = await fetchSystemInfoFromPort(startPort);
  let message;
  if (occupant?.runtime === 'desktop') {
    message = `Port ${startPort} is used by OpenChamber Desktop; using a free port`;
  } else if (occupant?.runtime) {
    message = `Port ${startPort} is used by an existing OpenChamber instance; using a free port`;
  } else {
    message = `Port ${startPort} in use; using a free port`;
  }
  if (typeof onNotice === 'function' && message) {
    onNotice({
      level: 'warning',
      code: 'PORT_REASSIGNED',
      message,
    });
  } else if (message) {
    console.warn(message);
  }
  return 0;
}

function getRunDir() {
  const dir = path.join(getDataDir(), 'run');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function getPidFilePath(port) {
  return path.join(getRunDir(), `openchamber-${port}.pid`);
}

async function getInstanceFilePath(port) {
  return path.join(getRunDir(), `openchamber-${port}.json`);
}

function readPidFile(pidFilePath) {
  try {
    const content = fs.readFileSync(pidFilePath, 'utf8').trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function writePidFile(pidFilePath, pid, onNotice) {
  try {
    fs.writeFileSync(pidFilePath, String(pid), { mode: 0o600 });
  } catch (error) {
    const message = `Could not write PID file: ${error.message}`;
    if (typeof onNotice === 'function') {
      onNotice({ level: 'warning', code: 'PID_FILE_WRITE_FAILED', message });
    } else {
      console.warn(`Warning: ${message}`);
    }
  }
}

function removePidFile(pidFilePath) {
  try {
    if (fs.existsSync(pidFilePath)) {
      fs.unlinkSync(pidFilePath);
    }
  } catch {
  }
}

function readInstanceOptions(instanceFilePath) {
  try {
    return JSON.parse(fs.readFileSync(instanceFilePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeInstanceOptions(instanceFilePath, options, onNotice) {
  try {
    const toStore = {
      port: options.port,
      host: typeof options.host === 'string' && options.host.length > 0 ? options.host : undefined,
      launchMode: options.launchMode === 'foreground' ? 'foreground' : 'daemon',
      uiPassword: typeof options.uiPassword === 'string' ? options.uiPassword : undefined,
      hasUiPassword: typeof options.uiPassword === 'string',
      startedAt: Number.isFinite(options.startedAt) ? options.startedAt : Date.now(),
    };
    fs.writeFileSync(instanceFilePath, JSON.stringify(toStore, null, 2), { mode: 0o600 });
  } catch (error) {
    const message = `Could not write instance file: ${error.message}`;
    if (typeof onNotice === 'function') {
      onNotice({ level: 'warning', code: 'INSTANCE_FILE_WRITE_FAILED', message });
    } else {
      console.warn(`Warning: ${message}`);
    }
  }
}

function removeInstanceFile(instanceFilePath) {
  try {
    if (fs.existsSync(instanceFilePath)) {
      fs.unlinkSync(instanceFilePath);
    }
  } catch {
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForProcessExit(pid, timeoutMs) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return Promise.resolve(true);
  }

  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      if (!isProcessRunning(pid)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(check, 150);
    };
    check();
  });
}

async function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return true;
  }

  const gracefulTimeoutMs = Number.isFinite(options.gracefulTimeoutMs) && options.gracefulTimeoutMs >= 0
    ? Math.trunc(options.gracefulTimeoutMs)
    : 2500;
  const forceTimeoutMs = Number.isFinite(options.forceTimeoutMs) && options.forceTimeoutMs >= 0
    ? Math.trunc(options.forceTimeoutMs)
    : 3000;

  if (process.platform === 'win32') {
    try {
      process.kill(pid);
    } catch {
    }

    if (await waitForProcessExit(pid, 800)) {
      return true;
    }

    try {
      spawnSync('taskkill', ['/pid', String(pid), '/t'], {
        stdio: 'ignore',
        timeout: 3000,
        windowsHide: true,
      });
    } catch {
    }

    if (await waitForProcessExit(pid, gracefulTimeoutMs)) {
      return true;
    }

    try {
      spawnSync('taskkill', ['/pid', String(pid), '/f', '/t'], {
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
    }

    return waitForProcessExit(pid, forceTimeoutMs);
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
  }

  if (await waitForProcessExit(pid, gracefulTimeoutMs)) {
    return true;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
  }

  return waitForProcessExit(pid, forceTimeoutMs);
}

async function stopInstanceProcess(pid, options = {}) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return true;
  }

  const shutdownWaitMs = Number.isFinite(options.shutdownWaitMs) && options.shutdownWaitMs >= 0
    ? Math.trunc(options.shutdownWaitMs)
    : 5000;

  if (await waitForProcessExit(pid, shutdownWaitMs)) {
    return true;
  }

  return terminateProcessTree(pid, options);
}

async function requestServerShutdown(port) {
  if (!Number.isFinite(port) || port <= 0) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const resp = await fetch(buildLocalUrl(port, '/api/system/shutdown'), {
      method: 'POST',
      signal: controller.signal,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(port, endpoint, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.trunc(options.timeoutMs)
    : 4000;
  const fetchOptions = { ...options };
  delete fetchOptions.timeoutMs;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(buildLocalUrl(port, endpoint), {
      ...fetchOptions,
      headers: {
        Accept: 'application/json',
        ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}),
        ...(fetchOptions.headers || {}),
      },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return { response, body };
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
      throw new Error(`Request to ${endpoint} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function isServerHealthReady(port, timeoutMs = 1000) {
  if (!Number.isFinite(port) || port <= 0) {
    return false;
  }
  const requestTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : 1000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeout);
  try {
    const response = await fetch(buildLocalUrl(port, '/health'), {
      headers: { Accept: 'text/plain' },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServerHealth(port, {
  timeoutMs = 60000,
  intervalMs = 250,
  onTick,
} = {}) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    const elapsedMs = Date.now() - start;
    if (typeof onTick === 'function') {
      onTick({ elapsedMs, timeoutMs });
    }
    if (await isServerHealthReady(port, Math.min(1000, intervalMs * 2))) {
      if (typeof onTick === 'function') {
        onTick({ elapsedMs: Math.min(Date.now() - start, timeoutMs), timeoutMs, complete: true });
      }
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (typeof onTick === 'function') {
    onTick({ elapsedMs: timeoutMs, timeoutMs, timedOut: true });
  }
  return false;
}

function isValidTunnelDoctorResponse(body) {
  if (!body || typeof body !== 'object') {
    return false;
  }
  if (body.ok !== true) {
    return false;
  }
  if (!Array.isArray(body.providerChecks)) {
    return false;
  }
  if (!Array.isArray(body.modes)) {
    return false;
  }
  return body.modes.every((entry) => {
    if (!entry || typeof entry.mode !== 'string') return false;
    // Accept new shape: { ready: boolean, blockers: [] }
    if (typeof entry.ready === 'boolean' && Array.isArray(entry.blockers)) return true;
    // Accept server shape: { checks: [], summary: { ready: boolean } }
    if (Array.isArray(entry.checks) && entry.summary && typeof entry.summary.ready === 'boolean') return true;
    return false;
  });
}

async function resolveDoctorPortStatuses(options = {}) {
  const runningEntries = await discoverRunningInstances();
  const desktopEntry = await discoverDesktopInstance();
  const statuses = [];

  if (options.explicitPort) {
    const requestedPort = options.port;
    const runningMatch = runningEntries.find((entry) => entry.port === requestedPort);
    if (runningMatch) {
      statuses.push({
        port: requestedPort,
        available: true,
        status: 'success',
        line: `port ${requestedPort} available for tunneling`,
        detail: 'Double-check this same port is configured in your provider dashboard/config.',
      });
      return { statuses, availableEntries: [runningMatch] };
    }

    if (desktopEntry && desktopEntry.port === requestedPort) {
      statuses.push({
        port: requestedPort,
        available: false,
        status: 'warning',
        line: `port ${requestedPort} not available (desktop runtime)`,
        detail: 'Use a CLI instance port from `openchamber serve` for tunneling.',
      });
      return { statuses, availableEntries: [] };
    }

    statuses.push({
      port: requestedPort,
      available: false,
      status: 'error',
      line: `port ${requestedPort} not available (no running instance)`,
      detail: `Start one with \`openchamber serve --port ${requestedPort}\`.`,
    });
    return { statuses, availableEntries: [] };
  }

  for (const entry of runningEntries) {
    statuses.push({
      port: entry.port,
      available: true,
      status: 'success',
      line: `port ${entry.port} available for tunneling`,
      detail: 'Double-check this same port is configured in your provider dashboard/config.',
    });
  }

  if (desktopEntry && !runningEntries.some((entry) => entry.port === desktopEntry.port)) {
    statuses.push({
      port: desktopEntry.port,
      available: false,
      status: 'warning',
      line: `port ${desktopEntry.port} not available (desktop runtime)`,
      detail: 'Use a CLI instance port from `openchamber serve` for tunneling.',
    });
  }

  if (runningEntries.length === 0) {
    statuses.push({
      port: null,
      available: false,
      status: 'warning',
      line: 'no CLI ports available for tunneling',
      detail: 'Start one with `openchamber serve`.',
    });
  }

  return { statuses, availableEntries: runningEntries };
}

async function discoverRunningInstances() {
  const instances = [];
  const runDir = getRunDir();
  try {
    const files = fs.readdirSync(runDir);
    const pidFiles = files.filter((file) => file.startsWith('openchamber-') && file.endsWith('.pid'));
    for (const file of pidFiles) {
      const port = parseInt(file.replace('openchamber-', '').replace('.pid', ''), 10);
      if (!Number.isFinite(port) || port <= 0) continue;
      const pidFilePath = path.join(runDir, file);
      const pid = readPidFile(pidFilePath);
      if (!pid || !isProcessRunning(pid)) {
        removePidFile(pidFilePath);
        removeInstanceFile(path.join(runDir, `openchamber-${port}.json`));
        continue;
      }
      const instanceFilePath = path.join(runDir, `openchamber-${port}.json`);
      let mtime = 0;
      let startedAt = 0;
      try {
        mtime = fs.statSync(pidFilePath).mtimeMs;
      } catch {
      }
      const storedOptions = readInstanceOptions(instanceFilePath);
      if (Number.isFinite(storedOptions?.startedAt)) {
        startedAt = storedOptions.startedAt;
      }
      const launchMode = storedOptions?.launchMode === 'foreground' ? 'foreground' : 'daemon';
      instances.push({ port, pid, pidFilePath, instanceFilePath, mtime, startedAt, launchMode });
    }
  } catch {
  }
  instances.sort((a, b) => a.port - b.port);
  return instances;
}

function getLatestInstance(instances) {
  if (!instances.length) return null;
  return [...instances].sort((a, b) => {
    const startedDelta = (b.startedAt || 0) - (a.startedAt || 0);
    if (startedDelta !== 0) return startedDelta;
    const mtimeDelta = (b.mtime || 0) - (a.mtime || 0);
    if (mtimeDelta !== 0) return mtimeDelta;
    return b.port - a.port;
  })[0];
}

async function fetchTunnelProvidersFromPort(port, fetchImpl = globalThis.fetch) {
  if (!Number.isFinite(port) || port <= 0 || typeof fetchImpl !== 'function') {
    return null;
  }
  try {
    const response = await fetchImpl(buildLocalUrl(port, '/api/openchamber/tunnel/providers'));
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    if (!body || !Array.isArray(body.providers)) return null;
    return body.providers;
  } catch {
    return null;
  }
}

async function fetchSystemInfoFromPort(port, fetchImpl = globalThis.fetch) {
  if (!Number.isFinite(port) || port <= 0 || typeof fetchImpl !== 'function') {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetchImpl(buildLocalUrl(port, '/api/system/info'), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    if (!body || typeof body.runtime !== 'string') return null;

    return {
      runtime: body.runtime,
      pid: Number.isFinite(body.pid) ? body.pid : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function inspectTunnelAttachability(port, { requireHealthy = true } = {}) {
  const info = await fetchSystemInfoFromPort(port);
  if (!info || typeof info.runtime !== 'string') {
    return { attachable: false, reason: 'unreachable' };
  }
  if (info.runtime === 'desktop') {
    return { attachable: false, reason: 'desktop', info };
  }
  if (requireHealthy) {
    const healthy = await isServerHealthReady(port, 1200);
    if (!healthy) {
      return { attachable: false, reason: 'unhealthy', info };
    }
  }
  return { attachable: true, reason: 'ok', info };
}

async function discoverDesktopInstance(fetchImpl = globalThis.fetch) {
  const port = readDesktopLocalPortFromSettings();
  if (!port) {
    return null;
  }

  const info = await fetchSystemInfoFromPort(port, fetchImpl);
  if (!info || info.runtime !== 'desktop') {
    return null;
  }

  return {
    port,
    pid: info.pid,
    runtime: info.runtime,
  };
}

async function resolveTunnelProviders(options = {}, deps = {}) {
  const readPorts = typeof deps.readPorts === 'function'
    ? deps.readPorts
    : async () => (await discoverRunningInstances()).map((entry) => entry.port);
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch;

  const candidatePorts = [];
  if (Number.isFinite(options.port) && options.port > 0) {
    candidatePorts.push(options.port);
  }

  const discoveredPorts = await Promise.resolve(readPorts());
  if (Array.isArray(discoveredPorts)) {
    candidatePorts.push(...discoveredPorts);
  }

  if (!candidatePorts.includes(DEFAULT_PORT)) {
    candidatePorts.push(DEFAULT_PORT);
  }

  for (const port of candidatePorts) {
    const providers = await fetchTunnelProvidersFromPort(port, fetchImpl);
    if (providers) {
      return { providers, source: `api:${port}` };
    }
  }

  return { providers: DEFAULT_TUNNEL_PROVIDER_CAPABILITIES, source: 'fallback' };
}

async function resolveTargetInstance({
  options,
  allowAutoStart,
  requireAll = false,
  rejectDesktopRuntime = false,
}) {
  let running = await discoverRunningInstances();

  if (options.all && requireAll) {
    if (running.length === 0) {
      throw new Error('No running OpenChamber instance found. Start one with `openchamber serve`.');
    }
    return running;
  }

  if (options.explicitPort) {
    const found = running.find((entry) => entry.port === options.port);
    if (found) {
      if (rejectDesktopRuntime) {
        const attachability = await inspectTunnelAttachability(found.port, { requireHealthy: true });
        if (!attachability.attachable) {
          if (attachability.reason === 'desktop') {
            throw new Error(
              `Port ${options.port} is used by OpenChamber Desktop app. Tunnel attach requires a CLI instance from \`openchamber serve\`.`
            );
          }
          throw new Error(
            `Port ${options.port} is not an attachable OpenChamber tunnel instance. Ensure it is healthy and running OpenChamber CLI runtime.`
          );
        }
      }
      return found;
    }

    if (rejectDesktopRuntime) {
      const systemInfo = await fetchSystemInfoFromPort(options.port);
      if (systemInfo?.runtime === 'desktop') {
        throw new Error(
          `Port ${options.port} is used by OpenChamber Desktop app. Tunnel attach requires a CLI instance from \`openchamber serve\`.`
        );
      }
    }

    if (allowAutoStart) {
      await commands.serve({
        port: options.port,
        explicitPort: true,
        uiPassword: options.uiPassword,
        suppressUnsafePortWarning: true,
        suppressUiPasswordWarning: true,
        suppressStartupSummary: true,
      });
      running = await discoverRunningInstances();
      const started = running.find((entry) => entry.port === options.port);
      if (started) return { ...started, autoStarted: true };
    }
    throw new Error(`No running OpenChamber instance found on port ${options.port}.`);
  }

  if (rejectDesktopRuntime) {
    const attachableEntries = [];
    let sawDesktop = false;
    for (const entry of running) {
      const attachability = await inspectTunnelAttachability(entry.port, { requireHealthy: true });
      if (attachability.reason === 'desktop') {
        sawDesktop = true;
      }
      if (attachability.attachable) {
        attachableEntries.push(entry);
      }
    }

    if (attachableEntries.length === 1) {
      return attachableEntries[0];
    }

    if (attachableEntries.length > 1) {
      const ports = attachableEntries.map((entry) => entry.port).join(', ');
      throw new Error(`Multiple attachable OpenChamber instances found: ${ports}. Use --port <port> or --all.`);
    }

    if (allowAutoStart) {
      const startedPort = await commands.serve({
        ...options,
        explicitPort: false,
        suppressUnsafePortWarning: true,
        suppressUiPasswordWarning: true,
        suppressStartupSummary: true,
      });
      running = await discoverRunningInstances();
      const started = running.find((entry) => entry.port === startedPort) || getLatestInstance(running);
      if (started) return { ...started, autoStarted: true };
    }

    if (sawDesktop) {
      throw new Error('Only OpenChamber Desktop instance(s) detected. Tunnel attach requires a CLI instance from `openchamber serve`.');
    }

    throw new Error('No attachable OpenChamber instance found. Start one with `openchamber serve`.');
  }

  if (running.length === 1) {
    return running[0];
  }

  if (running.length === 0) {
    if (allowAutoStart) {
      const startedPort = await commands.serve({
        ...options,
        explicitPort: false,
        suppressUnsafePortWarning: true,
        suppressUiPasswordWarning: true,
      });
      running = await discoverRunningInstances();
      const started = running.find((entry) => entry.port === startedPort) || getLatestInstance(running);
      if (started) return { ...started, autoStarted: true };
    }
    throw new Error('No running OpenChamber instance found. Start one with `openchamber serve`.');
  }

  const ports = running.map((entry) => entry.port).join(', ');
  throw new Error(`Multiple OpenChamber instances found: ${ports}. Use --port <port> or --all.`);
}

async function resolveTunnelReadEntries(options) {
  const running = await discoverRunningInstances();

  if (options.explicitPort) {
    const found = running.find((entry) => entry.port === options.port);
    if (!found) {
      throw new Error(`No running OpenChamber instance found on port ${options.port}.`);
    }
    return [found];
  }

  if (running.length === 0) {
    throw new Error('No running OpenChamber instance found. Start one with `openchamber serve`.');
  }

  return running;
}

function formatTunnelStatusLine(statusBody, port) {
  const active = Boolean(statusBody?.active);
  const provider = statusBody?.provider || 'unknown';
  const mode = statusBody?.mode || 'unknown';
  const url = statusBody?.url || 'n/a';
  return {
    status: active ? 'success' : 'neutral',
    line: `port ${port} ${active ? 'active' : 'inactive'} (${clackFormatProviderWithIcon(provider)}/${mode})`,
    detail: url,
  };
}

function formatModeRequirements(mode) {
  const requires = Array.isArray(mode?.requires) ? mode.requires.filter(Boolean) : [];
  if ((mode?.key || '') === 'managed-local') {
    return 'config-path (or default cloudflared config)';
  }
  if (requires.length === 0) {
    return 'none';
  }
  return requires.join(', ');
}

function annotateTunnelProvidersForOutput(providers) {
  if (!Array.isArray(providers)) return providers;
  return providers.map((provider) => {
    const modes = Array.isArray(provider?.modes) ? provider.modes : [];
    return {
      ...provider,
      modes: modes.map((mode) => ({
        ...mode,
        displayRequires: formatModeRequirements(mode),
      })),
    };
  });
}

function readTailLines(filePath, lineCount = DEFAULT_TAIL_LINES) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.slice(Math.max(0, lines.length - lineCount));
}

function followFile(filePath, onLine) {
  let position = 0;
  try {
    position = fs.statSync(filePath).size;
  } catch {
    position = 0;
  }

  let remainder = '';
  const interval = setInterval(() => {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size < position) {
        position = 0;
      }
      if (stats.size === position) {
        return;
      }

      const fd = fs.openSync(filePath, 'r');
      try {
        const length = stats.size - position;
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, position);
        position = stats.size;
        const chunk = remainder + buffer.toString('utf8');
        const parts = chunk.split(/\r?\n/);
        remainder = parts.pop() || '';
        for (const line of parts) {
          onLine(line);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
    }
  }, 400);

  return () => {
    clearInterval(interval);
  };
}

async function handleTunnelProfileSubcommand(options, action) {
  const sub = typeof action === 'string' ? action.trim().toLowerCase() : '';
  const store = ensureTunnelProfilesMigrated();

  if (!sub) {
    if (isJsonMode(options)) {
      printJson({
        command: 'tunnel profile',
        subcommands: ['list', 'show', 'add', 'remove'],
      });
      return;
    }

    if (!isQuietMode(options)) {
      clackIntro('Tunnel Profile');
      logStatus('info', 'Available subcommands', 'list, show, add, remove');
      clackLog.step('List profiles: `openchamber tunnel profile list`');
      clackLog.step('Show one profile: `openchamber tunnel profile show --name <name>`');
      clackLog.step('Add profile: `openchamber tunnel profile add --provider cloudflare --mode managed-remote --name <name> --hostname <host> --token <token>`');
      clackLog.step('Remove profile: `openchamber tunnel profile remove --name <name>`');
      clackOutro('Choose a subcommand');
    }
    return;
  }

  if (sub === 'list') {
    const providerFilter = normalizeProfileProvider(options.provider);
    const profiles = providerFilter
      ? store.profiles.filter((entry) => entry.provider === providerFilter)
      : store.profiles;
    if (isJsonMode(options)) {
      printJson({ profiles: redactProfilesForOutput(profiles, options.showSecrets) });
      return;
    }

    if (isQuietMode(options)) {
      for (const profile of profiles) {
        process.stdout.write(`${profile.name} ${profile.provider}/${profile.mode} ${profile.hostname}\n`);
      }
      return;
    }

    clackIntro('Tunnel Profiles');
    for (const profile of profiles) {
      logStatus('success', `${profile.name} (${profile.provider}/${profile.mode})`, `${profile.hostname} ${formatProfileTokenStatus(profile, options.showSecrets)}`);
    }
    clackOutro(`${profiles.length} profile(s)`);
    return;
  }

  if (sub === 'show') {
    const name = normalizeProfileName(options.name);
    if (!name) {
      throw new Error('`tunnel profile show` requires --name <name>.');
    }
    const { profile, error } = resolveProfileByName(store.profiles, name, options.provider);
    if (!profile) {
      throw new Error(error);
    }
    if (isJsonMode(options)) {
      printJson({ profile: redactProfileForOutput(profile, options.showSecrets) });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${profile.name} ${profile.provider}/${profile.mode} ${profile.hostname} ${formatProfileTokenStatus(profile, options.showSecrets)}\n`);
      return;
    }
    clackIntro('Tunnel Profile');
    logStatus('success', `${profile.name} (${profile.provider}/${profile.mode})`, `${profile.hostname} ${formatProfileTokenStatus(profile, options.showSecrets)}`);
    clackOutro('show complete');
    return;
  }

  if (sub === 'add') {
    let provider = normalizeProfileProvider(options.provider);
    let mode = normalizeProfileMode(options.mode);
    let name = normalizeProfileName(options.name);
    let hostname = normalizeProfileHostname(options.hostname);
    const resolvedTokenValue = resolveToken(options);
    let token = normalizeProfileToken(resolvedTokenValue);

    if (canPrompt(options)) {
      if (!provider) {
        const providerResult = await resolveTunnelProviders(options, {
          readPorts: async () => (await discoverRunningInstances()).map((entry) => entry.port),
        });
        const providerOptions = (Array.isArray(providerResult.providers) ? providerResult.providers : [])
          .map((entry) => normalizeProfileProvider(entry?.provider))
          .filter(Boolean)
          .map((providerId) => ({ value: providerId, label: clackFormatProviderWithIcon(providerId) }));

        if (providerOptions.length === 1) {
          provider = providerOptions[0].value;
        } else if (providerOptions.length > 1) {
          const selectedProvider = await clackSelect({
            message: 'Select tunnel provider',
            options: providerOptions,
          });
          if (clackIsCancel(selectedProvider)) {
            clackCancel('Profile add cancelled.');
            return;
          }
          provider = normalizeProfileProvider(selectedProvider);
        }
      }

      if (!mode) {
        mode = 'managed-remote';
      }

      if (!name) {
        const enteredName = await clackText({
          message: 'Profile name (Enter to accept/edit)',
          placeholder: 'prod-main',
          initialValue: 'prod-main',
          validate(value) {
            return normalizeProfileName(value).length > 0 ? undefined : 'Profile name is required.';
          },
        });
        if (clackIsCancel(enteredName)) {
          clackCancel('Profile add cancelled.');
          return;
        }
        name = normalizeProfileName(enteredName);
      }

      const existingProfile = provider && name
        ? store.profiles.find((entry) => entry.provider === provider && entry.name.toLowerCase() === name.toLowerCase())
        : null;

      if (!hostname) {
        const enteredHostname = await clackText({
          message: 'Tunnel hostname (Enter to accept/edit)',
          placeholder: existingProfile?.hostname || 'app.example.com',
          initialValue: existingProfile?.hostname || 'app.example.com',
          validate(value) {
            return normalizeProfileHostname(value).length > 0 ? undefined : 'Hostname is required.';
          },
        });
        if (clackIsCancel(enteredHostname)) {
          clackCancel('Profile add cancelled.');
          return;
        }
        hostname = normalizeProfileHostname(enteredHostname);
      }

      if (!token && existingProfile?.token) {
        const useExistingToken = await clackConfirm({
          message: `Reuse saved token for profile '${existingProfile.name}'?`,
          initialValue: true,
        });
        if (clackIsCancel(useExistingToken)) {
          clackCancel('Profile add cancelled.');
          return;
        }
        if (useExistingToken) {
          token = existingProfile.token;
        }
      }
    }

    if (!provider || !mode || !name || !hostname) {
      throw new Error('`tunnel profile add` requires --provider, --mode managed-remote, --name, and --hostname.');
    }

    if (!token) {
      if (canPrompt(options)) {
        const entered = await clackPassword({
          message: `Enter tunnel token for profile '${name}'`,
        });
        if (clackIsCancel(entered) || !entered || !entered.trim()) {
          clackCancel('Profile add cancelled.');
          return;
        }
        token = normalizeProfileToken(entered.trim());
      }
      if (!token) {
        throw new Error('`tunnel profile add` requires a token (--token, --token-file, or --token-stdin).');
      }
    }
    if (mode !== 'managed-remote') {
      throw new Error('`tunnel profile add` currently supports only --mode managed-remote.');
    }

    const existingIndex = store.profiles.findIndex(
      (entry) => entry.provider === provider && entry.name.toLowerCase() === name.toLowerCase()
    );

    if (existingIndex >= 0 && !options.force && !options.dryRun) {
      if (canPrompt(options)) {
        const shouldOverwrite = await clackConfirm({
          message: `Profile '${name}' already exists for provider '${provider}'. Overwrite?`,
        });
        if (clackIsCancel(shouldOverwrite) || !shouldOverwrite) {
          clackCancel('Profile add cancelled.');
          return;
        }
      } else {
        throw new Error(`Profile '${name}' already exists for provider '${provider}'. Use --force to overwrite.`);
      }
    }

    if (options.dryRun) {
      const dryRunResult = {
        ok: true,
        dryRun: true,
        action: existingIndex >= 0 ? 'overwrite' : 'create',
        profile: redactProfileForOutput({ name, provider, mode, hostname, token }, options.showSecrets),
      };
      if (isJsonMode(options)) {
        printJson(dryRunResult);
      } else if (!isQuietMode(options)) {
        clackIntro('Tunnel Profile Add (dry-run)');
        logStatus('info', `Would ${existingIndex >= 0 ? 'overwrite' : 'create'}: ${name} (${provider}/${mode})`, `${hostname} ${formatProfileTokenStatus({ token }, options.showSecrets)}`);
        clackOutro('dry-run complete (no changes applied)');
      }
      return;
    }

    const next = [...store.profiles];
    const now = Date.now();
    if (existingIndex >= 0) {
      const current = next[existingIndex];
      next[existingIndex] = {
        ...current,
        mode,
        hostname,
        token,
        updatedAt: now,
      };
    } else {
      next.push({
        id: crypto.randomUUID(),
        name,
        provider,
        mode,
        hostname,
        token,
        createdAt: now,
        updatedAt: now,
      });
    }

    const persisted = { version: TUNNEL_PROFILES_VERSION, profiles: next };
    writeTunnelProfilesToDisk(persisted);
    writeManagedRemotePairsToDiskFromProfiles(persisted);
    const added = persisted.profiles.find((entry) => entry.provider === provider && entry.name.toLowerCase() === name.toLowerCase());

    if (isJsonMode(options)) {
      printJson({ ok: true, profile: redactProfileForOutput(added, options.showSecrets) });
      return;
    }

    if (isQuietMode(options)) {
      process.stdout.write(`saved ${added.name} ${added.provider}/${added.mode} ${added.hostname}\n`);
      return;
    }

    console.log('');
    clackIntro(boldText('Tunnel Profile Saved'));
    logStatus('success', `${added.name} (${added.provider}/${added.mode})`, `${added.hostname} ${formatProfileTokenStatus(added, options.showSecrets)}`);
    clackOutro('save complete');
    logStatus('info', '[START_PROFILE]', `openchamber tunnel start --profile ${added.name}`);
    clackOutro('');
    return;
  }

  if (sub === 'remove') {
    const name = normalizeProfileName(options.name);
    if (!name) {
      throw new Error('`tunnel profile remove` requires --name <name>.');
    }
    const { profile, error } = resolveProfileByName(store.profiles, name, options.provider);
    if (!profile) {
      throw new Error(error);
    }

    const next = store.profiles.filter((entry) => entry.id !== profile.id);
    const persisted = { version: TUNNEL_PROFILES_VERSION, profiles: next };
    writeTunnelProfilesToDisk(persisted);
    writeManagedRemotePairsToDiskFromProfiles(persisted);

    if (isJsonMode(options)) {
      printJson({ ok: true, removed: redactProfileForOutput(profile, options.showSecrets) });
      return;
    }

    if (isQuietMode(options)) {
      process.stdout.write(`removed ${profile.name} ${profile.provider}/${profile.mode} ${profile.hostname}\n`);
      return;
    }

    clackIntro('Tunnel Profile Removed');
    logStatus('success', `${profile.name} (${profile.provider}/${profile.mode})`, profile.hostname);
    clackOutro('remove complete');
    return;
  }

  const knownProfileActions = ['list', 'show', 'add', 'remove'];
  const suggestion = findClosestMatch(sub, knownProfileActions);
  const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
  throw new TunnelCliError(
    `Unknown tunnel profile subcommand '${sub}'.${hint} Use 'openchamber tunnel help'.`,
    EXIT_CODE.USAGE_ERROR
  );
}

const commands = {
  async serve(options) {
    const showOutput = shouldRenderHumanOutput(options);
    const jsonMessages = [];
    const emitNotice = (notice) => {
      if (!notice || typeof notice !== 'object' || typeof notice.message !== 'string') return;
      const level = notice.level === 'error' ? 'error' : (notice.level === 'warning' ? 'warning' : 'info');

      if (isJsonMode(options)) {
        jsonMessages.push({
          level,
          code: notice.code,
          message: notice.message,
        });
        return;
      }

      if (showOutput) {
        logStatus(level, notice.message);
        return;
      }

      if (!isQuietMode(options)) {
        const prefix = level === 'warning' ? 'Warning' : level === 'error' ? 'Error' : 'Info';
        const line = `${prefix}: ${notice.message}`;
        if (level === 'error') {
          console.error(line);
        } else {
          console.warn(line);
        }
      }
    };
    const explicitPort = options.explicitPort === true;
    const targetPort = await resolveAvailablePort(options.port, explicitPort, emitNotice);

    if (targetPort !== 0 && !options.suppressUnsafePortWarning) {
      assertSafeBrowserPort(targetPort, { context: 'OpenChamber serve' });
    }

    if (targetPort !== 0) {
      const pidFilePath = await getPidFilePath(targetPort);
      const existingPid = readPidFile(pidFilePath);
      if (existingPid && isProcessRunning(existingPid)) {
        throw new Error(`OpenChamber is already running on port ${targetPort} (PID: ${existingPid})`);
      }

      if (explicitPort && !(await isPortAvailable(targetPort, options.host))) {
        const systemInfo = await fetchSystemInfoFromPort(targetPort);
        if (systemInfo?.runtime === 'desktop') {
          throw new Error(
            `Port ${targetPort} is used by OpenChamber Desktop app. Choose another port or stop the desktop app.`
          );
        }
        if (systemInfo?.runtime) {
          throw new Error(`OpenChamber is already running on port ${targetPort}. Use \`openchamber status\` or \`openchamber stop --port ${targetPort}\`.`);
        }
        throw new Error(`Port ${targetPort} is already in use by another process.`);
      }
    }

    const opencodeBinary = await checkOpenCodeCLI(emitNotice);
    const serverPath = path.join(__dirname, '..', 'server', 'index.js');
    const preferredRuntime = getPreferredServerRuntime();
    const runtimeBin = preferredRuntime === 'bun' ? BUN_BIN : process.execPath;

    ensureLogsDir();
    const initialLogPort = targetPort === 0 ? 'auto' : String(targetPort);
    const initialLogPath = getLogFilePath(initialLogPort);
    rotateLogFile(initialLogPath);
    const logFd = fs.openSync(initialLogPath, 'a');

    const effectiveUiPassword = hasUiPasswordConfigured(options.uiPassword) ? options.uiPassword : undefined;
    if (!effectiveUiPassword && !options.suppressUiPasswordWarning) {
      const warningLine = 'OPENCHAMBER_UI_PASSWORD is not set';
      const warningDetail = 'browser UI is unsecured. Use --ui-password or OPENCHAMBER_UI_PASSWORD.';
      if (showOutput) {
        logStatus('warning', warningLine, warningDetail);
      } else if (isJsonMode(options)) {
        emitNotice({
          level: 'warning',
          code: 'UI_PASSWORD_MISSING',
          message: `${warningLine}; ${warningDetail}`,
        });
      } else if (!isQuietMode(options)) {
        console.warn(`Warning: ${warningLine}; ${warningDetail}`);
      }
    }
    // Foreground mode: run server inline so the CLI process is the server process.
    // Required for process managers like systemd (Type=simple) that track the
    // direct child rather than a detached grandchild.
    // IMPORTANT: foreground MUST remain inline (in-process). Do not convert to
    // child-process orchestration — that causes shell job-control suspension.
    if (options.foreground) {
      if (isJsonMode(options)) {
        throw new TunnelCliError(
          '--json is not supported with --foreground. Use --json with background (daemon) mode instead.',
          EXIT_CODE.USAGE_ERROR
        );
      }

      // Propagate resolved values into env before importing the server module.
      if (opencodeBinary) {
        process.env.OPENCODE_BINARY = opencodeBinary;
      }
      if (effectiveUiPassword) {
        process.env.OPENCHAMBER_UI_PASSWORD = effectiveUiPassword;
      }

      // In --quiet mode, redirect stdout/stderr to the log file so that
      // server runtime output (console.log calls) does not pollute the
      // deterministic CLI output contract.  In plain human mode, close the
      // log fd and let output go to the inherited terminal as before.
      const suppressServerOutput = isQuietMode(options);
      // Keep a reference to the real stdout.write so CLI output (port, JSON)
      // can bypass the log-file redirect.
      const realStdoutWrite = process.stdout.write.bind(process.stdout);
      if (suppressServerOutput) {
        const logStream = fs.createWriteStream(null, { fd: logFd });
        process.stdout.write = (chunk, encoding, callback) => {
          return logStream.write(chunk, encoding, callback);
        };
        process.stderr.write = (chunk, encoding, callback) => {
          return logStream.write(chunk, encoding, callback);
        };
      } else {
        // Close the log fd – in foreground human mode stdout/stderr are
        // inherited from the parent (e.g. journald/terminal).
        try {
          fs.closeSync(logFd);
        } catch {
        }
      }

      if (!isQuietMode(options)) {
        console.log(`Starting OpenChamber on port ${targetPort === 0 ? 'auto' : targetPort} (foreground)`);
      }

      const effectiveHost = typeof options.host === 'string' && options.host.length > 0
        ? options.host : undefined;

      const { startWebUiServer } = await import(pathToFileURL(serverPath).href);
      const controller = await startWebUiServer({
        port: targetPort,
        host: effectiveHost,
        uiPassword: effectiveUiPassword,
        attachSignals: false,
        exitOnShutdown: false,
      });

      const resolvedPort = controller.getPort();

      // Write PID / instance files so status, stop, and restart can discover
      // this foreground instance the same way they discover daemon instances.
      const fgPidFilePath = await getPidFilePath(resolvedPort);
      const fgInstanceFilePath = await getInstanceFilePath(resolvedPort);
      writePidFile(fgPidFilePath, process.pid, emitNotice);
      writeInstanceOptions(fgInstanceFilePath, {
        port: resolvedPort,
        host: effectiveHost,
        launchMode: 'foreground',
        uiPassword: effectiveUiPassword,
      }, emitNotice);

      if (isQuietMode(options)) {
        if (!options.suppressQuietOutput) {
          realStdoutWrite(`${resolvedPort}\n`);
        }
      }

      // Clean up PID / instance files.
      const cleanupFiles = () => {
        removePidFile(fgPidFilePath);
        removeInstanceFile(fgInstanceFilePath);
      };

      process.on('exit', cleanupFiles);

      // Idempotent graceful shutdown with deterministic exit codes.
      let shutdownInProgress = false;
      const shutdownForegroundServer = async (signal = 'SIGTERM') => {
        if (shutdownInProgress) return;
        shutdownInProgress = true;
        try {
          await controller.stop({ exitProcess: false });
        } catch {
        }
        cleanupFiles();
        foregroundServerActive = false;
        foregroundShutdown = null;
        const exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGQUIT' ? 131 : 143;
        process.exit(exitCode);
      };

      // Expose shutdown to the global SIGINT handler.
      foregroundShutdown = shutdownForegroundServer;
      foregroundServerActive = true;

      // Register signal handlers (additive, no removeAllListeners).
      process.on('SIGINT', () => { void shutdownForegroundServer('SIGINT'); });
      process.on('SIGTERM', () => { void shutdownForegroundServer('SIGTERM'); });
      process.on('SIGQUIT', () => { void shutdownForegroundServer('SIGQUIT'); });

      // Block forever – the process stays alive until signalled.
      await new Promise(() => {});
    }

    const serverArgs = [serverPath, '--port', String(targetPort)];
    const effectiveHost = typeof options.host === 'string' && options.host.length > 0 ? options.host : undefined;
    if (effectiveHost) {
      serverArgs.push('--host', effectiveHost);
    }

    const serveSpin = showOutput ? createSpinner(options) : null;

    const child = spawn(runtimeBin, serverArgs, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd, 'ipc'],
      env: {
        ...process.env,
        OPENCHAMBER_PORT: String(targetPort),
        OPENCODE_BINARY: opencodeBinary,
        ...(effectiveHost ? { OPENCHAMBER_HOST: effectiveHost } : {}),
        ...(effectiveUiPassword ? { OPENCHAMBER_UI_PASSWORD: effectiveUiPassword } : {}),
        ...(process.env.OPENCODE_SKIP_START ? { OPENCHAMBER_SKIP_OPENCODE_START: process.env.OPENCODE_SKIP_START } : {}),
      },
    });

    child.unref();
    serveSpin?.start(`Starting OpenChamber on port ${targetPort === 0 ? 'auto' : targetPort}...`);

    const resolvedPort = await new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(targetPort);
      }, 5000);

      child.on('message', (msg) => {
        if (settled) return;
        if (msg && msg.type === 'openchamber:ready' && typeof msg.port === 'number') {
          settled = true;
          clearTimeout(timeout);
          resolve(msg.port);
        }
      });

      child.on('exit', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(targetPort);
      });
    });

    try {
      if (typeof child.disconnect === 'function' && child.connected) {
        child.disconnect();
      }
    } catch {
    }

    try {
      fs.closeSync(logFd);
    } catch {
    }

    const resolvedLogPath = getLogFilePath(resolvedPort);
    if (initialLogPath !== resolvedLogPath && !fs.existsSync(resolvedLogPath)) {
      try {
        fs.renameSync(initialLogPath, resolvedLogPath);
      } catch {
      }
    }

    if (!isProcessRunning(child.pid)) {
      serveSpin?.error('Failed to start OpenChamber');
      throw new Error('Failed to start server in daemon mode');
    }

    const pidFilePath = await getPidFilePath(resolvedPort);
    const instanceFilePath = await getInstanceFilePath(resolvedPort);
    writePidFile(pidFilePath, child.pid, emitNotice);
    writeInstanceOptions(instanceFilePath, {
      port: resolvedPort,
      host: effectiveHost,
      launchMode: 'daemon',
      uiPassword: effectiveUiPassword,
    }, emitNotice);

    const serveResult = {
      port: resolvedPort,
      pid: child.pid,
      url: buildLocalUrl(resolvedPort, '/'),
      logs: `openchamber logs -p ${resolvedPort}`,
      launchMode: 'daemon',
    };

    if (isJsonMode(options)) {
      printJson({ ...serveResult, messages: jsonMessages });
      return resolvedPort;
    }

    if (isQuietMode(options)) {
      if (options.suppressQuietOutput) {
        return resolvedPort;
      }
      process.stdout.write(`${resolvedPort}\n`);
      return resolvedPort;
    }

    serveSpin?.clear();

    if (!options.suppressStartupSummary && showOutput) {
      clackIntro('OpenChamber Started');
      logStatus('success', `port ${serveResult.port} (PID: ${serveResult.pid})`);
      logStatus('info', `visit: ${serveResult.url}`);
      logStatus('info', `logs: ${serveResult.logs}`);
      clackOutro('daemon running');
    }

    return resolvedPort;
  },

  async stop(options) {
    const showOutput = shouldRenderHumanOutput(options);
    const suppressQuietOutput = options?.suppressQuietOutput === true;
    const jsonResults = [];
    const printQuietStopResults = () => {
      if (suppressQuietOutput) return;
      if (!isQuietMode(options) || isJsonMode(options)) return;
      if (jsonResults.length === 0) {
        process.stdout.write('none\n');
        return;
      }
      for (const result of jsonResults) {
        if (result.stopped) {
          process.stdout.write(`stopped ${result.port}\n`);
        } else {
          const reason = result.reason || 'failed';
          process.stderr.write(`failed ${result.port} ${reason}\n`);
        }
      }
    };
    const finish = (text) => {
      if (!showOutput) return;
      clackOutro(text);
    };

    if (showOutput) {
      clackIntro('OpenChamber Stop');
    }

    let runningInstances = await discoverRunningInstances();
    if (runningInstances.length === 0) {
      if (isJsonMode(options)) {
        printJson({ stoppedCount: 0, results: jsonResults });
      }
      if (showOutput) {
        logStatus('info', 'No running OpenChamber instances found');
        finish('nothing to stop');
      }
      printQuietStopResults();
      return;
    }

    if (options.explicitPort) {
      runningInstances = runningInstances.filter((entry) => entry.port === options.port);
      if (runningInstances.length === 0) {
        const systemInfo = await fetchSystemInfoFromPort(options.port);
        if (systemInfo?.runtime === 'desktop') {
          jsonResults.push({ port: options.port, runtime: 'desktop', stopped: false, reason: 'desktop-managed' });
          if (isJsonMode(options)) {
            printJson({ stoppedCount: 0, results: jsonResults, messages: [{ level: 'warning', code: 'DESKTOP_MANAGED_PORT', message: `Port ${options.port} is managed by OpenChamber Desktop and cannot be stopped with this command.` }] });
          }
          if (showOutput) {
            logStatus('warning', `port ${options.port} is managed by OpenChamber Desktop`, 'cannot be stopped with this command');
            finish('no changes applied');
          }
          printQuietStopResults();
          return;
        }

        if (systemInfo?.runtime) {
          const unmanagedStopSpin = showOutput ? createSpinner(options) : null;
          if (showOutput && !unmanagedStopSpin) {
            logStatus('info', `found unmanaged OpenChamber instance on port ${options.port}`, 'attempting shutdown');
          }
          unmanagedStopSpin?.start(`Stopping unmanaged OpenChamber on port ${options.port}...`);
          const requested = await requestServerShutdown(options.port);

          if (Number.isFinite(systemInfo.pid) && isProcessRunning(systemInfo.pid)) {
            await stopInstanceProcess(systemInfo.pid, {
              shutdownWaitMs: requested ? 5000 : 0,
              gracefulTimeoutMs: 2500,
              forceTimeoutMs: 3000,
            }).catch(() => false);
          }

          const stopped = await isPortAvailable(options.port);
          if (stopped) {
            unmanagedStopSpin?.stop(`Stopped unmanaged OpenChamber on port ${options.port}`);
            jsonResults.push({ port: options.port, runtime: 'unmanaged', stopped: true });
            if (isJsonMode(options)) {
              printJson({ stoppedCount: 1, results: jsonResults });
            }
            if (showOutput && !unmanagedStopSpin) {
              logStatus('success', `stopped OpenChamber on port ${options.port}`);
              finish('stop complete');
            }
            printQuietStopResults();
          } else if (requested) {
            unmanagedStopSpin?.stop(`Shutdown requested on port ${options.port} (still occupied)`);
            jsonResults.push({ port: options.port, runtime: 'unmanaged', stopped: false, reason: 'shutdown-requested-port-busy' });
            if (isJsonMode(options)) {
              printJson({
                status: 'warning',
                stoppedCount: 0,
                results: jsonResults,
                messages: [{ level: 'warning', code: 'SHUTDOWN_PARTIAL', message: `Shutdown was requested for port ${options.port}, but the port is still occupied.` }],
              });
            }
            if (showOutput && !unmanagedStopSpin) {
              logStatus('warning', `shutdown requested on port ${options.port}`, 'port is still occupied');
              finish('partial stop');
            }
            printQuietStopResults();
          } else {
            unmanagedStopSpin?.error(`Could not stop OpenChamber on port ${options.port}`);
            jsonResults.push({ port: options.port, runtime: 'unmanaged', stopped: false, reason: 'stop-failed' });
            if (isJsonMode(options)) {
              printJson({
                status: 'error',
                stoppedCount: 0,
                results: jsonResults,
                messages: [{ level: 'error', code: 'STOP_FAILED', message: `Could not stop OpenChamber on port ${options.port}.` }],
              });
            }
            if (showOutput && !unmanagedStopSpin) {
              logStatus('error', `could not stop OpenChamber on port ${options.port}`);
              finish('failed');
            }
            printQuietStopResults();
          }
          return;
        }

        jsonResults.push({ port: options.port, stopped: false, reason: 'not-found' });
        if (isJsonMode(options)) {
          printJson({ stoppedCount: 0, results: jsonResults });
        }
        if (showOutput) {
          logStatus('info', `no OpenChamber instance found on port ${options.port}`);
          finish('nothing to stop');
        }
        printQuietStopResults();
        return;
      }
    }

    for (const instance of runningInstances) {
      const stopSpin = showOutput ? createSpinner(options) : null;
      if (showOutput && !stopSpin) {
        logStatus('info', `stopping port ${instance.port} (PID: ${instance.pid})`);
      }
      stopSpin?.start(`Stopping OpenChamber on port ${instance.port}...`);
      try {
        const requested = await requestServerShutdown(instance.port);
        const stopped = await stopInstanceProcess(instance.pid, {
          shutdownWaitMs: requested ? 5000 : 0,
          gracefulTimeoutMs: 2500,
          forceTimeoutMs: 3000,
        });
        if (!stopped && isProcessRunning(instance.pid)) {
          throw new Error(`Timed out stopping pid ${instance.pid}`);
        }
        removePidFile(instance.pidFilePath);
        removeInstanceFile(instance.instanceFilePath);
        stopSpin?.stop(`Stopped OpenChamber on port ${instance.port}`);
        jsonResults.push({ port: instance.port, pid: instance.pid, stopped: true });
        if (showOutput && !stopSpin) {
          logStatus('success', `stopped port ${instance.port}`);
        }
      } catch (error) {
        stopSpin?.error(`Failed to stop OpenChamber on port ${instance.port}`);
        jsonResults.push({ port: instance.port, pid: instance.pid, stopped: false, reason: error instanceof Error ? error.message : String(error) });
        if (showOutput) {
          logStatus('error', `error stopping port ${instance.port}`, error.message);
        } else if (!isJsonMode(options) && !isQuietMode(options)) {
          console.error(`Error stopping port ${instance.port}: ${error.message}`);
        }
      }
    }

    if (isJsonMode(options)) {
      const stoppedCount = jsonResults.filter((entry) => entry.stopped).length;
      const hasFailure = jsonResults.some((entry) => !entry.stopped);
      printJson({
        status: hasFailure ? 'warning' : 'ok',
        stoppedCount,
        results: jsonResults,
      });
      return;
    }

    finish(`${runningInstances.length} instance(s)`);
    printQuietStopResults();
  },

  async restart(options) {
    const showOutput = shouldRenderHumanOutput(options);
    const restarted = [];

    if (showOutput) {
      clackIntro('OpenChamber Restart');
    }

    let runningInstances = await discoverRunningInstances();
    if (runningInstances.length === 0) {
      if (isJsonMode(options)) {
        printJson({ restartedCount: 0, results: restarted });
      }
      if (showOutput) {
        logStatus('info', 'No running OpenChamber instances to restart');
        clackOutro('nothing to restart');
      } else if (isQuietMode(options)) {
        process.stdout.write('restarted 0\n');
      }
      return;
    }

    if (options.explicitPort) {
      runningInstances = runningInstances.filter((entry) => entry.port === options.port);
      if (runningInstances.length === 0) {
        if (isJsonMode(options)) {
          printJson({ restartedCount: 0, results: restarted });
        }
        if (showOutput) {
          logStatus('warning', `no OpenChamber instance found on port ${options.port}`);
          clackOutro('nothing to restart');
        } else if (isQuietMode(options)) {
          process.stdout.write('restarted 0\n');
        }
        return;
      }
    }

    for (const instance of runningInstances) {
      const storedOptions = readInstanceOptions(instance.instanceFilePath) || { port: instance.port };
      const launchMode = instance.launchMode || 'daemon';
      const isForeground = launchMode === 'foreground';

      const restartPort = options.explicitPort ? options.port : instance.port;

      const restartSpin = showOutput ? createSpinner(options) : null;
      if (showOutput && !restartSpin) {
        logStatus('info', `restarting port ${instance.port}`, `mode: ${launchMode}`);
      }
      restartSpin?.start(`Restarting OpenChamber on port ${instance.port}...`);
      try {
        await this.stop({
          explicitPort: true,
          port: instance.port,
          quiet: true,
          suppressQuietOutput: true,
        });

        // Foreground instances are managed by a process manager (systemd,
        // Docker, etc.) that will restart them automatically after stop.
        // Do not call serve() here — just record the stop as a successful
        // restart and let the process manager handle the actual restart.
        if (isForeground) {
          restarted.push({ fromPort: instance.port, toPort: restartPort, launchMode, ok: true });
          restartSpin?.stop(`Stopped foreground instance on port ${instance.port} (process manager will restart)`);
          if (showOutput && !restartSpin) {
            logStatus('success', `port ${instance.port} stopped`, 'process manager will restart');
          }
          continue;
        }

        await new Promise((resolve) => setTimeout(resolve, 500));

        const restartedPort = await this.serve({
          port: restartPort,
          host: storedOptions.host,
          explicitPort: true,
          uiPassword: options.explicitUiPassword ? options.uiPassword : storedOptions.uiPassword,
          suppressStartupSummary: true,
          quiet: true,
          suppressUiPasswordWarning: true,
          suppressQuietOutput: true,
        });
        restarted.push({ fromPort: instance.port, toPort: restartedPort, launchMode, ok: true });
        restartSpin?.stop(`Restarted OpenChamber on port ${restartedPort}`);
        if (showOutput && !restartSpin) {
          logStatus('success', `port ${restartedPort} restarted`, `mode: ${launchMode}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        restartSpin?.error(`Failed to restart OpenChamber on port ${instance.port}`);
        if (showOutput && !restartSpin) {
          logStatus('error', `failed to restart port ${instance.port}`, message);
        }
        throw error;
      }
    }

    if (isJsonMode(options)) {
      printJson({ restartedCount: restarted.length, results: restarted.map((r) => ({ ...r, launchMode: r.launchMode })) });
      return;
    }

    if (showOutput) {
      clackOutro(`${runningInstances.length} instance(s) restarted`);
    } else if (isQuietMode(options)) {
      process.stdout.write(`restarted ${restarted.length}\n`);
    }
  },

  async status(options = {}) {
    const [runningInstances, desktopInstance] = await Promise.all([
      discoverRunningInstances(),
      discoverDesktopInstance(),
    ]);

    const toPasswordProtectionLabel = (value) => {
      if (value === true) return 'yes';
      if (value === false) return 'no';
      return 'unknown';
    };

    const desktopOnly = desktopInstance && !runningInstances.some((entry) => entry.port === desktopInstance.port)
      ? {
          runtime: 'desktop',
          port: desktopInstance.port,
          pid: Number.isFinite(desktopInstance.pid) ? desktopInstance.pid : null,
          launchMode: null,
          passwordProtected: null,
        }
      : null;

    const cliInstances = runningInstances.map((instance) => {
      const storedOptions = readInstanceOptions(instance.instanceFilePath) || {};
      const passwordProtected = storedOptions.hasUiPassword === true
        || (typeof storedOptions.uiPassword === 'string' && storedOptions.uiPassword.trim().length > 0);

      return {
        runtime: 'cli',
        port: instance.port,
        pid: instance.pid,
        launchMode: instance.launchMode || 'daemon',
        passwordProtected,
      };
    });

    const instances = desktopOnly ? [...cliInstances, desktopOnly] : cliInstances;
    const runningCount = instances.length;

    if (isJsonMode(options)) {
      printJson({
        state: runningCount > 0 ? 'running' : 'stopped',
        runningCount,
        instances,
      });
      return;
    }

    if (isQuietMode(options)) {
      if (runningCount === 0) {
        process.stdout.write('stopped\n');
        return;
      }

      for (const instance of instances) {
        process.stdout.write(
          `port ${instance.port} mode:${instance.launchMode || 'n/a'} pass:${toPasswordProtectionLabel(instance.passwordProtected)}\n`
        );
      }
      return;
    }

    clackIntro('OpenChamber Status');

    if (runningCount === 0) {
      logStatus('warning', 'stopped');
      clackOutro('no running instances');
      return;
    }

    for (const instance of instances) {
      const pidSuffix = Number.isFinite(instance.pid) ? ` (PID: ${instance.pid})` : '';
      const modeDetail = instance.launchMode ? `mode: ${instance.launchMode}` : '';
      const protectionDetail = `password: ${toPasswordProtectionLabel(instance.passwordProtected)}`;
      const detail = modeDetail ? `${modeDetail}; ${protectionDetail}` : protectionDetail;
      if (instance.runtime === 'desktop') {
        logStatus('info', `desktop app on port ${instance.port}${pidSuffix}`, detail);
      } else {
        logStatus('success', `port ${instance.port}${pidSuffix}`, detail);
      }
    }

    clackOutro(`${runningCount} running runtime(s)`);
  },

  async tunnel(options, subcommand, action) {
    switch (subcommand) {
      case 'help':
        showTunnelHelp();
        return;
      case 'profile':
        await handleTunnelProfileSubcommand(options, action);
        return;
      case 'providers': {
        const result = await resolveTunnelProviders(options, {
          readPorts: async () => (await discoverRunningInstances()).map((entry) => entry.port),
        });
        if (isJsonMode(options)) {
          printJson({ providers: annotateTunnelProvidersForOutput(result.providers), source: result.source });
          return;
        }
        if (isQuietMode(options)) {
          for (const provider of result.providers) {
            const modes = Array.isArray(provider?.modes) ? provider.modes : [];
            const providerId = provider?.provider || 'unknown';
            process.stdout.write(`provider ${providerId} modes ${modes.length}\n`);
            for (const mode of modes) {
              const requires = formatModeRequirements(mode).replace(/,\s+/g, ',');
              process.stdout.write(`mode ${mode?.key || 'unknown'} requires ${requires}\n`);
            }
          }
          return;
        }
        clackIntro('Tunnel Providers');
        for (const provider of result.providers) {
          const modes = Array.isArray(provider?.modes) ? provider.modes : [];
          clackLog.success(`${clackFormatProviderWithIcon(provider.provider)} — ${modes.length} mode(s)`);
          for (const mode of modes) {
            const label = mode.label || mode.key;
            const requires = formatModeRequirements(mode);
            clackLog.step(`${mode.key} — ${label}\n  requires: ${requires}`);
          }
        }
        clackOutro(`${result.providers.length} provider(s)`);
        return;
      }
      case 'ready': {
        const entries = await resolveTunnelReadEntries(options);
        const provider = typeof options.provider === 'string' && options.provider.trim().length > 0
          ? options.provider.trim().toLowerCase()
          : 'cloudflare';

        const results = [];
        for (const entry of entries) {
          try {
            const { response, body } = await requestJson(entry.port, `/api/openchamber/tunnel/check?provider=${encodeURIComponent(provider)}`);
            if (!response.ok) {
              results.push({ port: entry.port, error: body?.error || `check ${response.status}` });
              continue;
            }
            results.push({ port: entry.port, result: body });
          } catch (error) {
            results.push({ port: entry.port, error: error instanceof Error ? error.message : String(error) });
          }
        }

        if (isJsonMode(options)) {
          printJson({ instances: results });
          return;
        }

        if (isQuietMode(options)) {
          for (const result of results) {
            if (result.error) {
              process.stderr.write(`port ${result.port} failed: ${result.error}\n`);
              continue;
            }
            const providerId = result.result?.provider || provider;
            if (result.result?.available) {
              process.stdout.write(`port ${result.port} ready ${providerId} ${result.result?.version || 'unknown'}\n`);
            } else {
              process.stdout.write(`port ${result.port} not-ready ${providerId} ${result.result?.message || 'not ready'}\n`);
            }
          }
          return;
        }

        clackIntro('Tunnel Ready');
        for (const result of results) {
          if (result.error) {
            logStatus('error', `port ${result.port} failed`, result.error);
            continue;
          }

          logStatus(
            result.result?.available ? 'success' : 'warning',
            `port ${result.port} provider ${clackFormatProviderWithIcon(result.result?.provider || provider)}`,
            result.result?.available
              ? `ready (${result.result?.version || 'unknown version'})`
              : (result.result?.message || 'not ready'),
          );
        }
        clackOutro(`${results.length} instance(s)`);
        return;
      }
      case 'status': {
        const entries = await resolveTunnelReadEntries(options);

        const results = [];
        for (const entry of entries) {
          try {
            const { response, body } = await requestJson(entry.port, '/api/openchamber/tunnel/status');
            if (!response.ok) {
              results.push({ port: entry.port, error: body?.error || `status ${response.status}` });
              continue;
            }
            results.push({ port: entry.port, status: body });
          } catch (error) {
            results.push({ port: entry.port, error: error instanceof Error ? error.message : String(error) });
          }
        }

        if (isJsonMode(options)) {
          printJson({ instances: results });
          return;
        }

        if (isQuietMode(options)) {
          for (const result of results) {
            if (result.error) {
              process.stderr.write(`port ${result.port} failed: ${result.error}\n`);
              continue;
            }
            const active = Boolean(result.status?.active);
            const provider = result.status?.provider || 'unknown';
            const mode = result.status?.mode || 'unknown';
            const url = result.status?.url || 'n/a';
            process.stdout.write(`port ${result.port} ${active ? 'active' : 'inactive'} ${provider}/${mode} ${url}\n`);
          }
          return;
        }

        clackIntro('Tunnel Status');
        for (const result of results) {
          if (result.error) {
            logStatus('error', `port ${result.port} failed`, result.error);
            continue;
          }
          const sl = formatTunnelStatusLine(result.status, result.port);
          logStatus(sl.status, sl.line, sl.detail);
        }
        clackOutro(`${results.length} instance(s)`);
        return;
      }
      case 'doctor': {
        const doctorSpin = createSpinner(options);
        doctorSpin?.start('Running tunnel diagnostics...');

        // Phase 1: Port discovery
        const { statuses: portStatuses, availableEntries } = await resolveDoctorPortStatuses(options);

        // Phase 2: Provider diagnostics via the doctor endpoint
        doctorSpin?.message('Checking provider...');
        let providerOption = typeof options.provider === 'string' && options.provider.trim().length > 0
          ? options.provider.trim().toLowerCase()
          : '';

        let doctorProfile = null;
        let doctorHostnameOverride = typeof options.hostname === 'string' ? options.hostname.trim() : '';
        const explicitHostnameProvided = doctorHostnameOverride.length > 0;
        const explicitTokenProvided = Boolean(options.tokenStdin)
          || (typeof options.token === 'string' && options.token.trim().length > 0)
          || (typeof options.tokenFile === 'string' && options.tokenFile.trim().length > 0);
        let doctorTokenValue = resolveToken(options);
        let hasSavedManagedRemoteProfile = false;
        const normalizedMode = typeof options.mode === 'string' ? options.mode.trim().toLowerCase() : '';

        if (typeof options.profile === 'string' && options.profile.trim().length > 0) {
          const store = ensureTunnelProfilesMigrated();
          const resolved = resolveProfileByName(store.profiles, options.profile, providerOption || options.provider);
          if (!resolved.profile) {
            throw new Error(resolved.error);
          }
          doctorProfile = resolved.profile;
        } else if (!doctorHostnameOverride && !explicitTokenProvided && (!normalizedMode || normalizedMode === 'managed-remote')) {
          const store = ensureTunnelProfilesMigrated();
          const remoteProfiles = store.profiles.filter((entry) => {
            if (entry.mode !== 'managed-remote') return false;
            if (!providerOption) return true;
            return entry.provider === providerOption;
          });
          hasSavedManagedRemoteProfile = remoteProfiles.some((entry) => {
            const savedHostname = normalizeProfileHostname(entry.hostname);
            const savedToken = normalizeProfileToken(entry.token);
            return Boolean(savedHostname && savedToken);
          });
          if (remoteProfiles.length === 1) {
            doctorProfile = remoteProfiles[0];
          }
        }

        if (doctorProfile) {
          providerOption = providerOption || doctorProfile.provider;
          if (!doctorHostnameOverride && typeof doctorProfile.hostname === 'string') {
            doctorHostnameOverride = doctorProfile.hostname.trim();
          }
          if ((!doctorTokenValue || doctorTokenValue.trim().length === 0) && typeof doctorProfile.token === 'string') {
            doctorTokenValue = doctorProfile.token.trim();
          }
        }

        let doctorResult = null;
        let doctorError = null;
        const diagnosticsEntries = [...availableEntries].sort((a, b) => b.mtime - a.mtime);
        if (diagnosticsEntries.length > 0) {
          const query = new URLSearchParams();
          if (providerOption) query.set('provider', providerOption);
          if (typeof options.mode === 'string' && options.mode.trim().length > 0) {
            query.set('mode', options.mode.trim().toLowerCase());
          }
          if (typeof options.configPath === 'string') query.set('configPath', options.configPath);
          if (doctorHostnameOverride.length > 0) {
            query.set('managedRemoteTunnelHostname', doctorHostnameOverride);
          }
          if (hasSavedManagedRemoteProfile) {
            query.set('hasSavedManagedRemoteProfile', '1');
          }
          const doctorBody = {};
          doctorBody.managedRemoteTunnelTokenProvided = explicitTokenProvided;
          doctorBody.managedRemoteTunnelHostnameProvided = explicitHostnameProvided;
          if (typeof doctorTokenValue === 'string' && doctorTokenValue.trim().length > 0) {
            doctorBody.managedRemoteTunnelToken = doctorTokenValue;
          }

          const failedPorts = [];
          for (const diagnosticsEntry of diagnosticsEntries) {
            try {
              doctorSpin?.message(`Diagnosing provider on port ${diagnosticsEntry.port}...`);
              const doctorFetchOptions = { timeoutMs: 10000 };
              if (Object.keys(doctorBody).length > 0) {
                doctorFetchOptions.method = 'POST';
                doctorFetchOptions.body = JSON.stringify(doctorBody);
              }
              const { response, body } = await requestJson(
                diagnosticsEntry.port,
                `/api/openchamber/tunnel/doctor?${query.toString()}`,
                doctorFetchOptions,
              );
              if (response.ok && body?.ok && isValidTunnelDoctorResponse(body)) {
                doctorResult = body;
                doctorError = null;
                break;
              }

              const looksIncompatible = response.ok && (!body || typeof body !== 'object' || !body.ok);
              const fallbackError = looksIncompatible
                ? `port ${diagnosticsEntry.port}: doctor endpoint unavailable or incompatible (restart this CLI instance)`
                : `port ${diagnosticsEntry.port}: ${body?.error || `doctor ${response.status}`}`;
              failedPorts.push(fallbackError);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              failedPorts.push(`port ${diagnosticsEntry.port}: ${message}`);
            }
          }

          if (!doctorResult) {
            doctorError = failedPorts.length > 0
              ? failedPorts[0]
              : 'No compatible CLI instance found for tunnel doctor.';
          }
        }

        doctorSpin?.clear();

        // JSON output
        if (isJsonMode(options)) {
          const cliPorts = portStatuses
            .filter((s) => s.available)
            .map((s) => ({ port: s.port, type: 'cli', available: true }));
          const desktopPorts = portStatuses
            .filter((s) => !s.available)
            .map((s) => ({ port: s.port, type: 'desktop', available: false }));
          printJson({
            ports: [...cliPorts, ...desktopPorts],
            provider: doctorResult ? {
              id: doctorResult.provider,
              checks: doctorResult.providerChecks || [],
            } : null,
            modes: doctorResult?.modes || [],
            error: doctorError || undefined,
          });
          return;
        }

        if (isQuietMode(options)) {
          const cliPorts = portStatuses.filter((s) => s.available).map((s) => s.port);
          process.stdout.write(`cli-ports ${cliPorts.join(',') || 'none'}\n`);
          if (doctorError) {
            process.stderr.write(`doctor-error ${doctorError}\n`);
            return;
          }
          if (!doctorResult) {
            process.stdout.write('doctor unavailable\n');
            return;
          }

          const providerLabel = doctorResult.provider || providerOption || 'unknown';
          process.stdout.write(`provider ${providerLabel}\n`);
          const modes = Array.isArray(doctorResult.modes) ? doctorResult.modes : [];
          for (const modeEntry of modes) {
            const ready = modeEntry.ready === true || modeEntry.summary?.ready === true;
            if (ready) {
              process.stdout.write(`mode ${modeEntry.mode} ready\n`);
              continue;
            }

            const blockers = Array.isArray(modeEntry.blockers)
              ? modeEntry.blockers
              : (Array.isArray(modeEntry.checks)
                ? modeEntry.checks
                  .filter((c) => c?.status === 'fail' && c?.id !== 'startup_readiness')
                  .map((c) => c.detail || c.label || c.id)
                : []);
            process.stdout.write(`mode ${modeEntry.mode} not-ready ${blockers.length || 0}\n`);
            for (const blocker of blockers) {
              process.stdout.write(`blocker ${modeEntry.mode} ${String(blocker)}\n`);
            }
          }
          return;
        }

        // ── Section 1: Ports ──────────────────────────────────────
        const cliPorts = portStatuses.filter((s) => s.available);
        const unavailablePorts = portStatuses.filter((s) => !s.available);

        clackIntro(boldText('Ports'));
        for (const entry of cliPorts) {
          logStatus('success', `port ${entry.port} — CLI (available)`);
        }
        const desktopUnavailablePorts = [];
        for (const entry of unavailablePorts) {
          const isDesktop = typeof entry?.line === 'string' && entry.line.includes('desktop runtime');
          if (isDesktop) {
            desktopUnavailablePorts.push(entry.port);
            logStatus('error', `port ${entry.port} — Desktop (tunneling not supported)`);
            continue;
          }
          logStatus('error', `port ${entry.port} — No running instance`);
        }
        if (desktopUnavailablePorts.length > 0) {
          clackLog.message('Only CLI instances (openchamber serve) support tunneling.');
        }

        if (cliPorts.length === 0 && unavailablePorts.length === 0) {
          logStatus('warning', 'No running instances found', 'Start one with `openchamber serve`.');
          clackOutro('No ports available');
          return;
        }
        if (cliPorts.length === 0) {
          logStatus('warning', 'No CLI instances available for tunneling', 'Start one with `openchamber serve`.');
          clackOutro('No CLI ports available');
          return;
        }
        clackOutro(`${cliPorts.length} CLI ${cliPorts.length === 1 ? 'port' : 'ports'} available`);
        console.log('');

        if (doctorProfile) {
          logStatus('info', 'Using saved profile for managed-remote checks', `${doctorProfile.name} (${doctorProfile.provider}/${doctorProfile.mode})`);
          console.log('');
        }

        // ── Section 2: Provider ─────────────────────────────────
        if (doctorError) {
          clackIntro(boldText('Provider'));
          logStatus('error', 'Provider diagnostics failed', doctorError);
          clackOutro('Failed');
          return;
        }
        if (!doctorResult) {
          clackIntro(boldText('Provider'));
          logStatus('warning', 'Could not reach a running instance for diagnostics');
          clackOutro('Unavailable');
          return;
        }

        const providerLabel = clackFormatProviderWithIcon(doctorResult.provider || 'unknown');
        clackIntro(boldText(`Provider: ${providerLabel}`));

        let providerPassCount = 0;
        for (const check of (doctorResult.providerChecks || [])) {
          const passed = check.status === 'pass';
          if (passed) {
            providerPassCount++;
            logStatus('success', `${check.label}${check.detail ? ` — ${check.detail}` : ''}`);
          } else {
            logStatus('error', check.label, check.detail || undefined);
          }
        }

        const depCheck = (doctorResult.providerChecks || []).find(
          (c) => c.id === 'dependency' || c.id === 'provider_dependency',
        );
        if (depCheck && depCheck.status !== 'pass') {
          clackOutro('1 blocker — resolve before checking modes');
          return;
        }
        clackOutro(`${providerPassCount} ${providerPassCount === 1 ? 'check' : 'checks'} passed`);
        console.log('');

        // ── Section 3: Modes ────────────────────────────────────
        const DOCTOR_NOISE_CHECK_IDS = new Set(['startup_readiness', 'quick_mode_prerequisites']);
        const modes = doctorResult.modes || [];
        if (modes.length === 0) {
          return;
        }

        clackIntro(boldText('Modes'));
        let totalBlockers = 0;
        const troubleshootingHints = [];
        for (const modeEntry of modes) {
          const isReady = modeEntry.ready === true || modeEntry.summary?.ready === true;
          if (isReady) {
            const passDetail = Array.isArray(modeEntry.checks)
              ? modeEntry.checks.find((c) => c?.status === 'pass' && !DOCTOR_NOISE_CHECK_IDS.has(c?.id))?.detail
              : null;
            logStatus('success', `${modeEntry.mode} — Ready${passDetail ? ` (${passDetail})` : ''}`);
          } else {
            const blockers = Array.isArray(modeEntry.blockers)
              ? modeEntry.blockers
              : (Array.isArray(modeEntry.checks)
                ? modeEntry.checks
                  .filter((c) => c?.status === 'fail' && c?.id !== 'startup_readiness')
                  .map((c) => c.detail || c.label || c.id)
                : []);
            totalBlockers += blockers.length;
            const blockerCount = blockers.length;
            const blockerWord = blockerCount === 1 ? 'blocker' : 'blockers';
            logStatus('error', `${modeEntry.mode} — Not ready${blockerCount > 0 ? ` (${blockerCount} ${blockerWord})` : ''}`);
            for (const blocker of blockers) {
              clackLog.message(`  ${blocker}`);
            }

            const normalizedBlockers = blockers.map((blocker) => String(blocker).toLowerCase());
            const isManagedRemote = modeEntry.mode === 'managed-remote';
            const hasTokenIssue = normalizedBlockers.some((line) => line.includes('token')
              || line.includes('unauthorized')
              || line.includes('forbidden')
              || line.includes('authentication')
              || line.includes('auth'));
            const hasPortOrOriginIssue = normalizedBlockers.some((line) => line.includes('port')
              || line.includes('localhost')
              || line.includes('127.0.0.1')
              || line.includes('connection refused')
              || line.includes('dial tcp'));

            if (isManagedRemote && (hasPortOrOriginIssue || hasTokenIssue)) {
              troubleshootingHints.push({
                key: 'managed-remote-port',
                code: '[PORT_MISMATCH]',
                lines: [
                  'Cloudflare target must match the active OpenChamber CLI port.',
                  'Example: `http://127.0.0.1:<port>`',
                  'If CLI picked a different port, update Cloudflare or run `openchamber serve --port <port>`.',
                ],
              });
            }

            if (isManagedRemote && hasTokenIssue) {
              troubleshootingHints.push({
                key: 'managed-remote-token',
                code: '[QR_PREFETCH_TOKEN]',
                lines: [
                  'Some QR readers pre-fetch scanned URLs.',
                  'Pre-fetch can consume one-time bootstrap tokens.',
                  'If validation fails, generate a fresh token/QR and use it immediately in one browser/device.',
                ],
              });
            }
          }
        }
        clackOutro(totalBlockers > 0 ? `Done (${totalBlockers} ${totalBlockers === 1 ? 'issue' : 'issues'})` : 'All modes ready');

        const dedupedHints = [];
        const seenHintKeys = new Set();
        for (const hint of troubleshootingHints) {
          if (!seenHintKeys.has(hint.key)) {
            seenHintKeys.add(hint.key);
            dedupedHints.push(hint);
          }
        }

        if (dedupedHints.length > 0) {
          console.log('');
          clackIntro(boldText('Suggestion notes'));
          for (const hint of dedupedHints) {
            const lines = Array.isArray(hint.lines) ? hint.lines : [];
            const detail = lines.length > 0 ? lines.map((line) => `  ${line}`).join('\n') : undefined;
            logStatus('info', hint.code || '[NOTE]', detail);
          }
          clackOutro(`${dedupedHints.length} ${dedupedHints.length === 1 ? 'suggestion' : 'suggestions'}`);
        }
        return;
      }
      case 'start': {
        let provider = typeof options.provider === 'string' && options.provider.trim().length > 0
          ? options.provider.trim().toLowerCase()
          : '';
        let mode = typeof options.mode === 'string' && options.mode.trim().length > 0
          ? options.mode.trim().toLowerCase()
          : '';
        let resolvedTokenValue = resolveToken(options);
        let token = typeof resolvedTokenValue === 'string' ? resolvedTokenValue : undefined;
        let hostname = typeof options.hostname === 'string' ? options.hostname : undefined;
        let selectedProfile = null;

        if (options.explicitPort) {
          assertSafeBrowserPort(options.port, { context: 'Tunnel start' });
        }

        if (typeof options.profile === 'string' && options.profile.trim().length > 0) {
          const store = ensureTunnelProfilesMigrated();
          const resolved = resolveProfileByName(store.profiles, options.profile, provider || options.provider);
          if (!resolved.profile) {
            throw new Error(resolved.error);
          }
          selectedProfile = resolved.profile;
          provider = provider || selectedProfile.provider;
          mode = mode || selectedProfile.mode;
          token = (typeof token === 'string' && token.trim().length > 0) ? token : selectedProfile.token;
          hostname = typeof options.hostname === 'string' && options.hostname.trim().length > 0 ? options.hostname : selectedProfile.hostname;
        }

        // Interactive profile selection when no profile/mode specified in TTY
        if (!selectedProfile && !mode && canPrompt(options)) {
          const store = ensureTunnelProfilesMigrated();
          if (store.profiles.length > 0) {
            const profileChoice = await clackSelect({
              message: 'Start from a saved profile or choose a mode?',
              options: [
                { value: '__mode__', label: 'Choose a mode manually' },
                ...store.profiles.map((p) => ({
                  value: p.id,
                  label: `${p.name} (${p.provider}/${p.mode})`,
                  hint: p.hostname,
                })),
              ],
            });
            if (clackIsCancel(profileChoice)) {
              clackCancel('Tunnel start cancelled.');
              return;
            }
            if (profileChoice !== '__mode__') {
              selectedProfile = store.profiles.find((p) => p.id === profileChoice);
              if (selectedProfile) {
                provider = provider || selectedProfile.provider;
                mode = mode || selectedProfile.mode;
                token = (typeof token === 'string' && token.trim().length > 0) ? token : selectedProfile.token;
                hostname = typeof options.hostname === 'string' && options.hostname.trim().length > 0 ? options.hostname : selectedProfile.hostname;
              }
            }
          }
        }

        provider = provider || 'cloudflare';

        // Interactive mode selection when mode not yet resolved in TTY
        if (!mode && canPrompt(options)) {
          const providerCaps = DEFAULT_TUNNEL_PROVIDER_CAPABILITIES.find(
            (cap) => cap.provider === provider
          );
          const modes = providerCaps?.modes || [];
          if (modes.length > 1) {
            const modeChoice = await clackSelect({
              message: `Select tunnel mode for ${clackFormatProviderWithIcon(provider)}`,
              options: modes.map((m) => ({
                value: m.key,
                label: `${m.key} — ${m.label}`,
                hint: formatModeRequirements(m) !== 'none' ? `requires: ${formatModeRequirements(m)}` : undefined,
              })),
            });
            if (clackIsCancel(modeChoice)) {
              clackCancel('Tunnel start cancelled.');
              return;
            }
            mode = modeChoice;
          }
        }

        mode = mode || 'quick';
        if (mode === 'managed-remote') {
          if (!(typeof hostname === 'string' && hostname.trim().length > 0)) {
            if (canPrompt(options)) {
              const profilesStore = ensureTunnelProfilesMigrated();
              const lastManagedRemoteProfile = [...profilesStore.profiles]
                .filter((entry) => entry.provider === provider && entry.mode === 'managed-remote')
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
              const suggestedHostname = normalizeProfileHostname(lastManagedRemoteProfile?.hostname) || 'app.example.com';
              const enteredHostname = await clackText({
                message: 'Enter managed-remote tunnel hostname',
                placeholder: suggestedHostname,
                initialValue: suggestedHostname,
                validate(value) {
                  if (typeof value !== 'string' || value.trim().length === 0) {
                    return 'Hostname is required.';
                  }
                  return undefined;
                },
              });
              if (clackIsCancel(enteredHostname)) {
                clackCancel('Tunnel start cancelled.');
                return;
              }
              hostname = enteredHostname.trim();
            } else {
              throw new Error('Managed-remote mode requires --hostname <hostname>.');
            }
          }

          if (!(typeof token === 'string' && token.trim().length > 0)) {
            if (canPrompt(options)) {
              const entered = await clackPassword({
                message: 'Enter managed-remote tunnel token',
              });
              if (clackIsCancel(entered) || !entered || !entered.trim()) {
                clackCancel('Tunnel start cancelled.');
                return;
              }
              token = entered.trim();
            } else {
              throw new Error('Managed-remote mode requires a token (--token, --token-file, or --token-stdin).');
            }
          }

          if (!selectedProfile && canPrompt(options)) {
            const runChoice = await clackSelect({
              message: 'Run once, or save profile and run?',
              options: [
                { value: 'run', label: 'Run once', hint: 'Do not save profile' },
                { value: 'save-run', label: 'Save profile and run', hint: 'Reuse with --profile later' },
              ],
            });
            if (clackIsCancel(runChoice)) {
              clackCancel('Tunnel start cancelled.');
              return;
            }

            if (runChoice === 'save-run') {
              const suggestedName = suggestProfileNameFromHostname(hostname);
              const enteredProfileName = await clackText({
                message: 'Profile name',
                placeholder: suggestedName,
                initialValue: suggestedName,
                validate(value) {
                  return normalizeProfileName(value).length > 0 ? undefined : 'Profile name is required.';
                },
              });
              if (clackIsCancel(enteredProfileName)) {
                clackCancel('Tunnel start cancelled.');
                return;
              }

              const desiredName = normalizeProfileName(enteredProfileName);
              const store = ensureTunnelProfilesMigrated();
              const existingIndex = store.profiles.findIndex(
                (entry) => entry.provider === provider && entry.name.toLowerCase() === desiredName.toLowerCase()
              );

              if (existingIndex >= 0) {
                const shouldOverwrite = await clackConfirm({
                  message: `Profile '${desiredName}' already exists. Overwrite and run?`,
                  initialValue: true,
                });
                if (clackIsCancel(shouldOverwrite) || !shouldOverwrite) {
                  clackCancel('Tunnel start cancelled.');
                  return;
                }
              }

              const now = Date.now();
              const nextProfiles = [...store.profiles];
              if (existingIndex >= 0) {
                const current = nextProfiles[existingIndex];
                nextProfiles[existingIndex] = {
                  ...current,
                  mode: 'managed-remote',
                  hostname,
                  token,
                  updatedAt: now,
                };
              } else {
                nextProfiles.push({
                  id: crypto.randomUUID(),
                  name: desiredName,
                  provider,
                  mode: 'managed-remote',
                  hostname,
                  token,
                  createdAt: now,
                  updatedAt: now,
                });
              }

              const persisted = { version: TUNNEL_PROFILES_VERSION, profiles: nextProfiles };
              writeTunnelProfilesToDisk(persisted);
              writeManagedRemotePairsToDiskFromProfiles(persisted);

              selectedProfile = persisted.profiles.find(
                (entry) => entry.provider === provider && entry.name.toLowerCase() === desiredName.toLowerCase()
              ) || null;
            }
          }

          if (typeof options.token === 'string' && !options.tokenFile && !options.tokenStdin && canPrompt(options)) {
            clackBox(
              'Token passed via --token is visible in your shell history and process list.\n' +
              'Consider using --token-file or --token-stdin for better security.',
              'Security Warning',
            );
          }
        }

        if (mode === 'managed-local') {
          const hasConfigPath = typeof options.configPath === 'string' && options.configPath.trim().length > 0;
          if (!hasConfigPath && canPrompt(options)) {
            const lastConfigPath = readLastManagedLocalConfigPath();
            const defaultConfigPath = getDefaultCloudflaredConfigPath();
            const suggestedConfigPath = lastConfigPath || defaultConfigPath;
            const suggestedConfigFound = isReadableRegularFile(suggestedConfigPath);
            const defaultConfigFound = isReadableRegularFile(defaultConfigPath);

            if (suggestedConfigFound || defaultConfigFound) {
              const foundPath = suggestedConfigFound ? suggestedConfigPath : defaultConfigPath;
              const configChoice = await clackSelect({
                message: 'Managed-local config',
                options: [
                  {
                    value: 'default',
                    label: 'Use found config',
                    hint: foundPath,
                  },
                  {
                    value: 'custom',
                    label: 'Enter config path',
                  },
                ],
              });
              if (clackIsCancel(configChoice)) {
                clackCancel('Tunnel start cancelled.');
                return;
              }
              if (configChoice === 'default') {
                options.configPath = foundPath;
              }
            }

            if (!(typeof options.configPath === 'string' && options.configPath.trim().length > 0)) {
              const enteredPath = await clackText({
                message: 'Enter managed-local config path',
                placeholder: suggestedConfigPath,
                initialValue: suggestedConfigPath,
                validate(value) {
                  if (typeof value !== 'string' || value.trim().length === 0) {
                    return 'Config path is required.';
                  }
                  return undefined;
                },
              });
              if (clackIsCancel(enteredPath)) {
                clackCancel('Tunnel start cancelled.');
                return;
              }
              options.configPath = enteredPath.trim();
            }

            if (typeof options.configPath === 'string' && options.configPath.trim().length > 0) {
              writeLastManagedLocalConfigPath(options.configPath);
            }
          }
        }

        const ttlOverrides = await resolveTunnelTtlOverrides(options);
        if (ttlOverrides === null) {
          return;
        }
        const { connectTtlMs, sessionTtlMs } = ttlOverrides;

        if (options.dryRun) {
          const dryRunResult = {
            ok: true,
            dryRun: true,
            provider,
            mode,
            hostname: hostname || null,
            hasToken: typeof token === 'string' && token.trim().length > 0,
            profile: selectedProfile ? selectedProfile.name : null,
            configPath: options.configPath || null,
            connectTtlMs: connectTtlMs ?? null,
            sessionTtlMs: sessionTtlMs ?? null,
          };
          if (isJsonMode(options)) {
            printJson(dryRunResult);
          } else if (!isQuietMode(options)) {
            clackIntro('Tunnel Start (dry-run)');
            logStatus('info', `Would start ${clackFormatProviderWithIcon(provider)}/${mode}`, hostname || '(ephemeral URL)');
            clackOutro('dry-run complete (no changes applied)');
          }
          return;
        }

        if (!options.explicitPort && canPrompt(options)) {
          const runningInstances = await discoverRunningInstances();
          if (runningInstances.length > 1) {
            const safeInstances = runningInstances.filter((entry) => !isUnsafeBrowserPort(entry.port));
            if (safeInstances.length === 0) {
              throw new TunnelCliError(
                'All discovered OpenChamber instance ports are browser-unsafe. Start or target a safe port (3000, 5173, 8080, or high ephemeral).',
                EXIT_CODE.USAGE_ERROR,
              );
            }

            const attachabilityResults = await Promise.all(
              safeInstances.map(async (entry) => ({
                entry,
                attachability: await inspectTunnelAttachability(entry.port, { requireHealthy: true }),
              }))
            );
            const attachableSafeInstances = attachabilityResults
              .filter((item) => item.attachability.attachable)
              .map((item) => item.entry);

            if (attachableSafeInstances.length === 0) {
              throw new TunnelCliError(
                'No attachable OpenChamber CLI instances found on safe ports. Start one with `openchamber serve --port 3000`.',
                EXIT_CODE.USAGE_ERROR,
              );
            }

            const selectedPort = await clackSelect({
              message: 'Select OpenChamber instance port',
              options: attachableSafeInstances.map((entry) => ({
                value: entry.port,
                label: `port ${entry.port}`,
              })),
            });
            if (clackIsCancel(selectedPort)) {
              clackCancel('Tunnel start cancelled.');
              return;
            }
            options.port = Number(selectedPort);
            options.explicitPort = true;
          }
        }

        const instance = await resolveTargetInstance({ options, allowAutoStart: true, rejectDesktopRuntime: true });
        if (instance?.autoStarted && shouldRenderHumanOutput(options)) {
          logStatus(
            'info',
            `Using auto-started instance on port ${instance.port}`,
            `logs: openchamber logs -p ${instance.port}`,
          );
        }

        if (instance?.autoStarted) {
          setCancelCleanup(async () => {
            try {
              await commands.stop({ explicitPort: true, port: instance.port });
            } catch {
            }
          });
        }

        if (instance?.autoStarted) {
          const healthProgress = await createProgress(options, { max: 60 });
          healthProgress?.start(`Waiting for OpenChamber on port ${instance.port} to become healthy (up to 60s)...`);
          let progressedSeconds = 0;
          const healthy = await waitForServerHealth(instance.port, {
            timeoutMs: 60000,
            intervalMs: 250,
            onTick({ elapsedMs, complete }) {
              if (!healthProgress) return;
              const elapsedSeconds = Math.min(60, Math.floor(elapsedMs / 1000));
              const delta = elapsedSeconds - progressedSeconds;
              if (delta > 0) {
                healthProgress.advance(delta);
                progressedSeconds = elapsedSeconds;
                healthProgress.message(`Waiting for OpenChamber health (${progressedSeconds}s / 60s)...`);
              }
              if (complete && progressedSeconds < 60) {
                const remaining = 60 - progressedSeconds;
                if (remaining > 0) {
                  healthProgress.advance(remaining);
                  progressedSeconds = 60;
                }
              }
            },
          });
          if (!healthy) {
            healthProgress?.stop('OpenChamber is still starting');
            throw new Error(
              `OpenChamber on port ${instance.port} is still starting after 60s. Startup time can vary by machine performance. ` +
              `Wait another minute, then check health with \`curl -fsS ${buildLocalUrl(instance.port, '/health')}\`. ` +
              `If health is OK, retry tunnel start with \`openchamber tunnel start --port ${instance.port}\`. ` +
              `For diagnostics run \`openchamber logs -p ${instance.port}\`.`
            );
          }
          healthProgress?.stop(`Instance ${instance.port} is healthy`);
        }

        if (selectedProfile && mode === 'managed-remote') {
          const tokenSyncPayload = {
            presetId: selectedProfile.id,
            presetName: selectedProfile.name,
            managedRemoteTunnelHostname: hostname,
            managedRemoteTunnelToken: token,
          };
          const { response: presetResponse, body: presetBody } = await requestJson(instance.port, '/api/openchamber/tunnel/managed-remote-token', {
            method: 'PUT',
            body: JSON.stringify(tokenSyncPayload),
          });
          if (!presetResponse.ok || !presetBody?.ok) {
            throw new Error(presetBody?.error || `Failed to sync tunnel profile token (${presetResponse.status})`);
          }
        }

        const payload = {
          provider,
          mode,
          ...(typeof connectTtlMs === 'number' ? { connectTtlMs } : {}),
          ...(typeof sessionTtlMs === 'number' ? { sessionTtlMs } : {}),
          ...(options.configPath === null ? { configPath: null } : {}),
          ...(typeof options.configPath === 'string' ? { configPath: options.configPath } : {}),
          ...(typeof token === 'string' ? { token } : {}),
          ...(typeof hostname === 'string' ? { hostname } : {}),
          ...(selectedProfile ? {
            managedRemoteTunnelPresetId: selectedProfile.id,
            managedRemoteTunnelPresetName: selectedProfile.name,
          } : {}),
        };

        const spin = createSpinner(options);
        spin?.start(`Starting ${clackFormatProviderWithIcon(provider)}/${mode} tunnel...`);

        let response;
        let body;
        try {
          ({ response, body } = await requestJson(instance.port, '/api/openchamber/tunnel/start', {
            method: 'POST',
            body: JSON.stringify(payload),
            timeoutMs: 60000,
          }));
        } catch (error) {
          if (error instanceof Error && /\/api\/openchamber\/tunnel\/start/.test(error.message) && /timed out/.test(error.message)) {
            spin?.error('Tunnel start timed out');
            throw new Error(
              `Tunnel start timed out after 60s. cloudflared may still be starting; check with \`openchamber tunnel status --port ${instance.port}\`. Run \`openchamber logs -p ${instance.port}\` for details.`
            );
          }
          spin?.error('Tunnel start failed');
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${message} Run \`openchamber logs -p ${instance.port}\` for details.`);
        }

        if (!response.ok || !body?.ok) {
          spin?.error('Tunnel start failed');
          const baseError = body?.error || `Tunnel start failed (${response.status})`;
          const isCloudflareTimeout = /context deadline exceeded|Client\.Timeout exceeded while awaiting headers|failed to request quick Tunnel/i.test(baseError);
          const userError = isCloudflareTimeout
            ? `Cloudflare quick tunnel request timed out. ${baseError}`
            : baseError;
          throw new Error(`${userError} Run \`openchamber logs -p ${instance.port}\` for details.`);
        }

        // Avoid duplicate "Tunnel started" lines: spinner completion is implied by
        // the subsequent structured success section.
        spin?.clear();

        const replayCommand = buildTunnelStartReplayCommand({
          port: instance.port,
          provider,
          mode,
          profileName: selectedProfile?.name,
          configPath: options.configPath,
          hostname,
          connectTtlMs,
          sessionTtlMs,
          qr: options.qr === true,
          noQr: options.noQr === true,
          includeTokenPlaceholder: !selectedProfile && mode === 'managed-remote' && typeof token === 'string' && token.trim().length > 0,
          tokenViaStdin: options.tokenStdin === true,
          tokenFileProvided: typeof options.tokenFile === 'string' && options.tokenFile.trim().length > 0,
        });

        if (isJsonMode(options)) {
          printJson({ port: instance.port, replayCommand, ...body });
        } else if (isQuietMode(options)) {
          const quietUrl = body.connectUrl || body.url || 'n/a';
          process.stdout.write(`port ${instance.port} ${quietUrl}\n`);
        } else {
          console.log('');
          clackIntro(boldText('Tunnel Started'));
          logStatus('success', `port ${instance.port} ${clackFormatProviderWithIcon(body.provider)}/${body.mode}`);
          logStatus('success', body.connectUrl || body.url || 'n/a');
          if (body.replacedTunnel) {
            const revokedBootstrapCount = Number.isFinite(body.revokedBootstrapCount) ? body.revokedBootstrapCount : 0;
            const invalidatedSessionCount = Number.isFinite(body.invalidatedSessionCount) ? body.invalidatedSessionCount : 0;
            const previousMode = typeof body?.replaced?.mode === 'string' ? body.replaced.mode : 'unknown';
            logStatus(
              'warning',
              `replaced previous ${previousMode} tunnel`,
              `revoked ${revokedBootstrapCount}, invalidated ${invalidatedSessionCount}`,
            );
          }
          clackOutro('');

          const optionalTips = [
            { line: 'Check status', detail: 'openchamber tunnel status' },
            { line: 'Stop tunnel', detail: 'openchamber tunnel stop' },
            { line: 'If needed, repeat with same settings', detail: replayCommand },
          ];

          if (!selectedProfile && mode === 'managed-remote' && typeof hostname === 'string' && hostname.trim().length > 0) {
            const profileSaveCommand = buildTunnelProfileAddCommand({ provider, hostname });
            optionalTips.push({ line: 'Optional: save reusable profile (stores hostname + token locally)', detail: profileSaveCommand });
            optionalTips.push({ line: 'Start from saved profile', detail: 'openchamber tunnel start --profile <name>' });
          }

          console.log('');
          clackIntro('Optional Tips');
          for (const tip of optionalTips) {
            logStatus('info', tip.line, tip.detail);
          }
          clackOutro('');
        }

        setCancelCleanup(null);

        if (shouldDisplayTunnelQr(options)) {
          const url = body.connectUrl || body.url;
          if (typeof url === 'string' && url.length > 0) {
            await displayTunnelQrCode(url);
          }
        }
        return;
      }
      case 'stop': {
        let entries;
        if (options.all) {
          entries = await resolveTargetInstance({ options, allowAutoStart: false, requireAll: true });
          if (entries.length > 1 && !options.force && canPrompt(options)) {
            const shouldStop = await clackConfirm({
              message: `Stop tunnels on all ${entries.length} instances?`,
            });
            if (clackIsCancel(shouldStop) || !shouldStop) {
              clackCancel('Tunnel stop cancelled.');
              return;
            }
          }
        } else {
          entries = [await resolveTargetInstance({ options, allowAutoStart: false })];
        }

        const results = [];
        for (const entry of entries) {
          const tunnelStopSpin = shouldRenderHumanOutput(options) ? createSpinner(options) : null;
          tunnelStopSpin?.start(`Stopping tunnel on port ${entry.port}...`);
          try {
            const { response, body } = await requestJson(entry.port, '/api/openchamber/tunnel/stop', {
              method: 'POST',
            });
            if (!response.ok) {
              tunnelStopSpin?.error(`Failed to stop tunnel on port ${entry.port}`);
              results.push({ port: entry.port, error: body?.error || `stop ${response.status}` });
              continue;
            }
            tunnelStopSpin?.stop(`Stopped tunnel on port ${entry.port}`);
            results.push({ port: entry.port, result: body });
          } catch (error) {
            tunnelStopSpin?.error(`Failed to stop tunnel on port ${entry.port}`);
            results.push({ port: entry.port, error: error instanceof Error ? error.message : String(error) });
          }
        }

        if (isJsonMode(options)) {
          printJson({ instances: results });
          return;
        }

        if (isQuietMode(options)) {
          for (const result of results) {
            if (result.error) {
              process.stderr.write(`port ${result.port} failed: ${result.error}\n`);
              continue;
            }
            process.stdout.write(`port ${result.port} stopped\n`);
          }
          return;
        }

        clackIntro('Tunnel Stop');
        for (const result of results) {
          if (result.error) {
            logStatus('error', `port ${result.port} failed`, result.error);
            continue;
          }
          logStatus('success', `port ${result.port} stopped`, `revoked ${result.result?.revokedBootstrapCount || 0}, invalidated ${result.result?.invalidatedSessionCount || 0}`);
        }
        clackOutro(`${results.length} instance(s)`);
        return;
      }
      case 'completion': {
        const shell = action || 'bash';
        const completionScript = generateCompletionScript(shell);
        if (!completionScript) {
          throw new TunnelCliError(
            `Unsupported shell '${shell}'. Supported: bash, zsh, fish.`,
            EXIT_CODE.USAGE_ERROR
          );
        }
        process.stdout.write(completionScript);
        return;
      }
      default: {
        const knownTunnelSubcommands = ['help', 'providers', 'ready', 'doctor', 'status', 'start', 'stop', 'profile', 'completion'];
        const suggestion = findClosestMatch(subcommand, knownTunnelSubcommands);
        const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
        throw new TunnelCliError(
          `Unknown tunnel subcommand '${subcommand}'.${hint} Use 'openchamber tunnel help'.`,
          EXIT_CODE.USAGE_ERROR
        );
      }
    }
  },

  async logs(options) {
    const showFrames = shouldRenderHumanOutput(options);
    const shouldPrefixLines = options.all || !showFrames;
    let targets = [];
    const running = await discoverRunningInstances();

    if (options.all) {
      targets = running;
      if (targets.length === 0) {
        throw new Error('No running OpenChamber instance found.');
      }
    } else if (options.explicitPort) {
      const found = running.find((entry) => entry.port === options.port);
      if (!found) {
        throw new Error(`No running OpenChamber instance found on port ${options.port}.`);
      }
      targets = [found];
    } else {
      const latest = getLatestInstance(running);
      if (!latest) {
        throw new Error('No running OpenChamber instance found.');
      }
      targets = [latest];
      if (shouldRenderHumanOutput(options)) {
        logStatus('info', `no port specified; using latest started instance on port ${latest.port}`);
      }
    }

    if (isJsonMode(options)) {
      if (options.follow) {
        throw new Error('`openchamber logs --json` requires `--no-follow` for deterministic JSON output.');
      }
      const entries = targets.map((target) => {
        const logPath = getLogFilePath(target.port);
        return {
          port: target.port,
          logPath,
          lines: readTailLines(logPath, options.lines),
        };
      });
      printJson({ entries });
      return;
    }

    if (showFrames) {
      clackIntro('OpenChamber Logs');
    }

    for (const target of targets) {
      const logPath = getLogFilePath(target.port);
      const lines = readTailLines(logPath, options.lines);
      if (showFrames) {
        logStatus('info', `port ${target.port}`, logPath);
      }

      for (const line of lines) {
        if (shouldPrefixLines) {
          console.log(`[${target.port}] ${line}`);
        } else {
          console.log(line);
        }
      }
    }

    if (showFrames) {
      clackOutro(options.follow ? 'following (Ctrl+C to stop)' : 'tail complete');
    }

    if (!options.follow) {
      return;
    }

    const unsubs = targets.map((target) => {
      const logPath = getLogFilePath(target.port);
      return followFile(logPath, (line) => {
        if (shouldPrefixLines) {
          console.log(`[${target.port}] ${line}`);
        } else {
          console.log(line);
        }
      });
    });

    await new Promise((resolve) => {
      const onSignal = () => {
        for (const unsub of unsubs) {
          unsub();
        }
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        resolve();
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
    });
  },

  async update(options = {}) {
    const showOutput = shouldRenderHumanOutput(options);
    const updateSpin = createSpinner(options);

    const packageManagerPath = path.join(__dirname, '..', 'server', 'lib', 'package-manager.js');
    const {
      checkForUpdates,
      executeUpdate,
      detectPackageManager,
      getCurrentVersion,
    } = await importFromFilePath(packageManagerPath);

    const runningInstances = await discoverRunningInstances();
    const currentVersion = getCurrentVersion();

    if (showOutput) {
      clackIntro('OpenChamber Update');
    }

    if (showOutput && !updateSpin) {
      logStatus('info', `current version: ${currentVersion}`);
    }

    updateSpin?.start('Checking for updates...');

    const updateInfo = await checkForUpdates();
    if (updateInfo.error) {
      updateSpin?.error('Update check failed');
      if (showOutput) {
        clackOutro('update failed');
      }
      throw new Error(updateInfo.error);
    }
    if (!updateInfo.available) {
      if (isJsonMode(options)) {
        printJson({
          currentVersion,
          latestVersion: updateInfo.version || currentVersion,
          updated: false,
        });
        return;
      }
      if (showOutput && !updateSpin) {
        logStatus('success', 'you are running the latest version');
      }
      updateSpin?.stop('Already up to date');
      if (showOutput) {
        clackOutro('no update needed');
      } else if (isQuietMode(options)) {
        process.stdout.write(`up-to-date ${currentVersion}\n`);
      }
      return;
    }

    if (showOutput && !updateSpin) {
      logStatus('info', `updating ${updateInfo.currentVersion || currentVersion} -> ${updateInfo.version || 'latest'}`);
    }
    updateSpin?.message(`Updating to ${updateInfo.version || 'latest'}...`);

    if (runningInstances.length > 0) {
      updateSpin?.message(`Stopping ${runningInstances.length} running instance(s)...`);
      for (const instance of runningInstances) {
        try {
          const requested = await requestServerShutdown(instance.port);
          await stopInstanceProcess(instance.pid, {
            shutdownWaitMs: requested ? 5000 : 0,
            gracefulTimeoutMs: 2500,
            forceTimeoutMs: 3000,
          });
          removePidFile(instance.pidFilePath);
        } catch {
        }
      }
    }

    const pm = detectPackageManager();
    const result = executeUpdate(pm, { silent: isJsonMode(options) || isQuietMode(options) });
    if (!result.success) {
      updateSpin?.error('Update failed');
      if (showOutput) {
        clackOutro('update failed');
      }
      throw new Error(`Update failed with exit code ${result.exitCode}`);
    }

    if (runningInstances.length > 0) {
      updateSpin?.message(`Restarting ${runningInstances.length} instance(s)...`);
      for (const instance of runningInstances) {
        const storedOptions = readInstanceOptions(instance.instanceFilePath) || { port: instance.port };
        await this.serve({
          port: storedOptions.port || instance.port,
          host: storedOptions.host,
          explicitPort: true,
          uiPassword: storedOptions.uiPassword,
          suppressStartupSummary: true,
          suppressUiPasswordWarning: true,
          quiet: true,
        });
      }
    }

    if (showOutput && !updateSpin) {
      logStatus('success', `updated to ${updateInfo.version || 'latest'}`);
    }
    updateSpin?.stop(`Updated to ${updateInfo.version || 'latest'}`);
    if (isJsonMode(options)) {
      printJson({
        currentVersion,
        latestVersion: updateInfo.version || 'latest',
        updated: true,
        restartedCount: runningInstances.length,
      });
      return;
    }
    if (showOutput) {
      clackOutro('update complete');
    } else if (isQuietMode(options)) {
      process.stdout.write(`updated ${updateInfo.version || 'latest'}\n`);
    }
  },
};

async function main() {
  const parsed = parseArgs();
  const { command, subcommand, tunnelAction, options, removedFlagErrors, helpRequested, versionRequested } = parsed;
  activeCommandOptions = options;

  if (versionRequested) {
    if (isJsonMode(options)) {
      printJson({ version: PACKAGE_JSON.version });
    } else {
      console.log(PACKAGE_JSON.version);
    }
    return;
  }

  if (removedFlagErrors.length > 0) {
    if (isJsonMode(options)) {
      printJson({
        status: 'error',
        error: {
          message: removedFlagErrors[0],
          details: removedFlagErrors,
        },
      });
    } else {
      for (const error of removedFlagErrors) {
        console.error(`Error: ${error}`);
      }
    }
    process.exit(1);
  }

  if (helpRequested) {
    if (command === 'tunnel') {
      showTunnelHelp();
    } else {
      showHelp();
    }
    return;
  }

  if (command === 'tunnel') {
    await commands.tunnel(options, subcommand, tunnelAction);
    return;
  }

  if (!commands[command]) {
    const knownCommands = ['serve', 'stop', 'restart', 'status', 'tunnel', 'logs', 'update'];
    const suggestion = findClosestMatch(command, knownCommands);
    const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
    if (isJsonMode(options)) {
      printJson({
        status: 'error',
        error: {
          message: `Unknown command '${command}'.${hint}`,
        },
        messages: [{ level: 'info', code: 'USAGE_HELP', message: 'Use --help to see available commands' }],
      });
    } else {
      console.error(`Error: Unknown command '${command}'.${hint}`);
      console.error('Use --help to see available commands');
    }
    process.exit(EXIT_CODE.USAGE_ERROR);
  }

  await commands[command](options);
}

const isCliExecution = isModuleCliExecution(process.argv[1], import.meta.url, fs.realpathSync, 'openchamber');

if (isCliExecution) {
  let isHandlingSigint = false;
  process.on('SIGINT', () => {
    if (isHandlingSigint) {
      return;
    }
    if (foregroundServerActive) {
      if (typeof foregroundShutdown === 'function') {
        void foregroundShutdown('SIGINT');
      }
      return;
    }
    isHandlingSigint = true;
    (async () => {
      clackCancel('Operation cancelled.');
      if (onCancelCleanup) {
        try {
          await onCancelCleanup();
        } catch {
        } finally {
          setCancelCleanup(null);
        }
      }
      process.exit(130);
    })();
  });

  process.on('unhandledRejection', (reason, promise) => {
    if (isJsonMode(activeCommandOptions)) {
      printJson({
        status: 'error',
        error: {
          message: `Unhandled rejection: ${String(reason)}`,
        },
      });
    } else {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    }
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    if (isJsonMode(activeCommandOptions)) {
      printJson({
        status: 'error',
        error: {
          message: `Uncaught exception: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    } else {
      console.error('Uncaught Exception:', error);
    }
    process.exit(1);
  });

  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (isJsonMode(activeCommandOptions)) {
      printJson({
        status: 'error',
        error: {
          message,
        },
      });
    } else if (process.stdout?.isTTY && !HAS_PLAIN_FLAG) {
      clackIntro(boldText('Error'));
      logStatus('error', message);
      clackOutro('failed');
    } else {
      console.error(`Error: ${message}`);
    }
    const exitCode = error instanceof TunnelCliError ? error.exitCode : EXIT_CODE.GENERAL_ERROR;
    process.exit(exitCode);
  });
}

export {
  commands,
  parseArgs,
  hasUiPasswordConfigured,
  shouldDisplayTunnelQr,
  isValidTunnelDoctorResponse,
  readDesktopLocalPortFromSettings,
  getPidFilePath,
  resolveTunnelProviders,
  fetchTunnelProvidersFromPort,
  fetchSystemInfoFromPort,
  discoverRunningInstances,
  ensureTunnelProfilesMigrated,
  resolveToken,
  redactProfileForOutput,
  redactProfilesForOutput,
  maskToken,
  findClosestMatch,
  generateCompletionScript,
  TunnelCliError,
  EXIT_CODE,
  warnIfUnsafeFilePermissions,
};
