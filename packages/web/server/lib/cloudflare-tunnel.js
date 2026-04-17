import { resolveExecutable, spawnCloudflaredTunnel, spawnOnce } from './SpawnUtils.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'yaml';

const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const MANAGED_TUNNEL_STARTUP_TIMEOUT_MS = 20000;
const MANAGED_TUNNEL_LIVENESS_FALLBACK_MS = 6000;
const TUNNEL_MODE_QUICK = 'quick';
const TUNNEL_MODE_MANAGED_REMOTE = 'managed-remote';
const TUNNEL_MODE_MANAGED_LOCAL = 'managed-local';

async function searchPathFor(command) {
  return resolveExecutable(command);
}

export async function checkCloudflaredAvailable() {
  const cfPath = await searchPathFor('cloudflared');
  if (cfPath) {
    try {
      const result = await spawnOnce(cfPath, ['--version']);
      if (result.exitCode === 0) {
        return { available: true, path: cfPath, version: result.stdout.trim() };
      }
    } catch {
      // Ignore
    }
  }
  return { available: false, path: null, version: null };
}

export function printCloudflareTunnelInstallHelp() {
  const platform = process.platform;
  let installCmd = '';

  if (platform === 'darwin') {
    installCmd = 'brew install cloudflared';
  } else if (platform === 'win32') {
    installCmd = 'winget install --id Cloudflare.cloudflared';
  } else {
    installCmd = 'Download from https://github.com/cloudflare/cloudflared/releases';
  }

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  Cloudflare tunnel requires 'cloudflared' to be installed        ║
╚══════════════════════════════════════════════════════════════════╝

Install instructions for your platform:

  macOS:    brew install cloudflared
  Windows:  winget install --id Cloudflare.cloudflared
  Linux:    Download from https://github.com/cloudflare/cloudflared/releases

Or visit: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflared/downloads/
`);
}

const normalizeHostname = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    const hostname = parsed.hostname.trim().toLowerCase();
    if (!hostname || hostname.includes('*')) {
      return null;
    }
    return hostname;
  } catch {
    return null;
  }
};

export function normalizeCloudflareTunnelHostname(value) {
  return normalizeHostname(value);
}

export async function checkCloudflareApiReachability({ fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (typeof fetchImpl !== 'function') {
    return {
      reachable: false,
      status: null,
      error: 'Fetch API is unavailable in this runtime.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('https://api.trycloudflare.com/', {
      method: 'GET',
      signal: controller.signal,
    });
    return {
      reachable: true,
      status: response.status,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      reachable: false,
      status: null,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

const READY_LOG_PATTERNS = [
  /registered tunnel connection/i,
  /connection[^\n]*registered/i,
  /starting metrics server/i,
  /connected to edge/i,
];

const MANAGED_LOCAL_CONFIG_MAX_BYTES = 256 * 1024;
const MANAGED_LOCAL_CONFIG_ALLOWED_EXTENSIONS = new Set(['.yml', '.yaml', '.json']);

const FATAL_LOG_PATTERNS = [
  /error parsing.*config/i,
  /failed to .*config/i,
  /invalid token/i,
  /unauthorized/i,
  /credentials file .* not found/i,
  /provided tunnel credentials are invalid/i,
];

function assertReadableFile(filePath, contextLabel) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    throw new Error(`${contextLabel} file was not found. Select a valid cloudflared config file.`);
  }

  if (!stats.isFile()) {
    throw new Error(`${contextLabel} path is not a file. Select a cloudflared config file.`);
  }

  const extension = path.extname(filePath).toLowerCase();
  if (!MANAGED_LOCAL_CONFIG_ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`${contextLabel} must be a .yml, .yaml, or .json file.`);
  }

  if (stats.size <= 0) {
    throw new Error(`${contextLabel} file is empty.`);
  }
  if (stats.size > MANAGED_LOCAL_CONFIG_MAX_BYTES) {
    throw new Error(`${contextLabel} file is too large (max ${MANAGED_LOCAL_CONFIG_MAX_BYTES} bytes).`);
  }

  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch {
    throw new Error(`${contextLabel} file is not readable. Check file permissions and try again.`);
  }
}

function extractHostnameFromCloudflaredConfigDetailed(configPath) {
  if (typeof configPath !== 'string' || configPath.trim().length === 0) {
    return { hostname: null, parseError: null };
  }

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return {
      hostname: null,
      parseError: new Error('Could not read the managed local tunnel config file. Check that the file exists and is accessible.'),
    };
  }

  let parsed;
  try {
    parsed = yaml.parse(raw);
  } catch {
    return {
      hostname: null,
      parseError: new Error('Managed local tunnel config is invalid. Use a valid cloudflared YAML/JSON config file.'),
    };
  }

  const ingress = Array.isArray(parsed?.ingress) ? parsed.ingress : [];
  for (const rule of ingress) {
    const hostname = normalizeHostname(rule?.hostname);
    if (hostname) {
      return { hostname, parseError: null };
    }
  }

  return { hostname: null, parseError: null };
}

const extractHostnameFromCloudflaredConfig = (configPath) => {
  return extractHostnameFromCloudflaredConfigDetailed(configPath).hostname;
};

const getDefaultCloudflaredConfigPath = () => path.join(os.homedir(), '.cloudflared', 'config.yml');

export function inspectManagedLocalCloudflareConfig({ configPath, hostname } = {}) {
  const requestedPath = typeof configPath === 'string' ? configPath.trim() : '';
  const effectiveConfigPath = requestedPath || getDefaultCloudflaredConfigPath();

  try {
    if (requestedPath) {
      assertReadableFile(effectiveConfigPath, 'Managed local tunnel config');
    } else {
      assertReadableFile(effectiveConfigPath, 'Managed local tunnel default config');
    }
  } catch (error) {
    return {
      ok: false,
      effectiveConfigPath,
      resolvedHostname: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const configHostnameResult = extractHostnameFromCloudflaredConfigDetailed(effectiveConfigPath);
  if (configHostnameResult.parseError) {
    return {
      ok: false,
      effectiveConfigPath,
      resolvedHostname: null,
      error: configHostnameResult.parseError.message,
    };
  }

  const resolvedHostname = normalizeHostname(hostname) || configHostnameResult.hostname;
  if (!resolvedHostname) {
    return {
      ok: false,
      effectiveConfigPath,
      resolvedHostname: null,
      error: 'Managed local tunnel hostname is required (set --hostname or include ingress hostname in config).',
    };
  }

  return {
    ok: true,
    effectiveConfigPath,
    resolvedHostname,
    error: null,
  };
}

export async function startCloudflareQuickTunnel({ originUrl }) {
  const cfCheck = await checkCloudflaredAvailable();

  if (!cfCheck.available) {
    printCloudflareTunnelInstallHelp();
    throw new Error('cloudflared is not installed');
  }

  console.log(`Using cloudflared: ${cfCheck.path} (${cfCheck.version})`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-cf-'));

  const cleanupTempDir = () => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  };

  let controller;
  try {
    controller = await spawnCloudflaredTunnel({
      binaryPath: cfCheck.path,
      args: ['tunnel', '--url', originUrl],
      env: { HOME: tempDir },
      mode: 'quick',
      startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
      onStderr: (text) => {
        process.stderr.write(text);
      },
    });
  } catch (error) {
    cleanupTempDir();
    throw error;
  }

  return {
    mode: TUNNEL_MODE_QUICK,
    stop: async () => {
      await controller.stop({ force: true });
      cleanupTempDir();
    },
    process: controller.process,
    getPublicUrl: () => controller.getPublicUrl(),
  };
}

export async function startCloudflareManagedRemoteTunnel({ token, hostname, tokenFilePath }) {
  const cfCheck = await checkCloudflaredAvailable();

  if (!cfCheck.available) {
    printCloudflareTunnelInstallHelp();
    throw new Error('cloudflared is not installed');
  }

  const normalizedToken = typeof token === 'string' ? token.trim() : '';
  const normalizedHost = typeof hostname === 'string' ? hostname.trim().toLowerCase() : '';

  if (!normalizedToken) {
    throw new Error('Managed remote tunnel token is required');
  }
  if (!normalizedHost) {
    throw new Error('Managed remote tunnel hostname is required');
  }

  let effectiveTokenFilePath = typeof tokenFilePath === 'string' ? tokenFilePath : null;
  let tempTokenFile = null;

  if (!effectiveTokenFilePath) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-cf-token-'));
    effectiveTokenFilePath = path.join(tempDir, 'token');
    fs.writeFileSync(effectiveTokenFilePath, normalizedToken, { encoding: 'utf8', mode: 0o600 });
    tempTokenFile = { dir: tempDir, path: effectiveTokenFilePath };
  }

  const publicUrl = `https://${normalizedHost}`;

  const cleanupTempTokenFile = () => {
    if (tempTokenFile) {
      try {
        if (fs.existsSync(tempTokenFile.dir)) {
          fs.rmSync(tempTokenFile.dir, { recursive: true, force: true });
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  };

  let controller;
  try {
    controller = await spawnCloudflaredTunnel({
      binaryPath: cfCheck.path,
      args: ['tunnel', 'run', '--token-file', effectiveTokenFilePath],
      mode: 'managed',
      startupTimeoutMs: MANAGED_TUNNEL_STARTUP_TIMEOUT_MS,
      readyPatterns: READY_LOG_PATTERNS,
      fatalPatterns: FATAL_LOG_PATTERNS,
      livenessFallbackMs: MANAGED_TUNNEL_LIVENESS_FALLBACK_MS,
      onStderr: (text) => {
        process.stderr.write(text);
      },
    });
  } catch (error) {
    cleanupTempTokenFile();
    throw error;
  }

  return {
    mode: TUNNEL_MODE_MANAGED_REMOTE,
    stop: async () => {
      await controller.stop({ force: true });
      cleanupTempTokenFile();
    },
    process: controller.process,
    getPublicUrl: () => publicUrl,
  };
}

export async function startCloudflareManagedLocalTunnel({ configPath, hostname }) {
  const cfCheck = await checkCloudflaredAvailable();

  if (!cfCheck.available) {
    printCloudflareTunnelInstallHelp();
    throw new Error('cloudflared is not installed');
  }

  const requestedPath = typeof configPath === 'string' ? configPath.trim() : '';
  const effectiveConfigPath = requestedPath || getDefaultCloudflaredConfigPath();

  if (requestedPath) {
    assertReadableFile(effectiveConfigPath, 'Managed local tunnel config');
  } else {
    assertReadableFile(effectiveConfigPath, 'Managed local tunnel default config');
  }

  const configHostnameResult = extractHostnameFromCloudflaredConfigDetailed(effectiveConfigPath);
  if (configHostnameResult.parseError) {
    throw configHostnameResult.parseError;
  }

  const resolvedHost = normalizeHostname(hostname) || configHostnameResult.hostname;

  if (!resolvedHost) {
    throw new Error('Managed local tunnel hostname is required (use --tunnel-hostname or add an ingress hostname to the cloudflared config)');
  }

  const args = ['tunnel'];
  if (requestedPath) {
    args.push('--config', effectiveConfigPath);
  }
  args.push('run');

  const publicUrl = `https://${resolvedHost}`;

  const controller = await spawnCloudflaredTunnel({
    binaryPath: cfCheck.path,
    args,
    mode: 'managed',
    startupTimeoutMs: MANAGED_TUNNEL_STARTUP_TIMEOUT_MS,
    readyPatterns: READY_LOG_PATTERNS,
    fatalPatterns: FATAL_LOG_PATTERNS,
    livenessFallbackMs: MANAGED_TUNNEL_LIVENESS_FALLBACK_MS,
    onStderr: (text) => {
      process.stderr.write(text);
    },
  });

  return {
    mode: TUNNEL_MODE_MANAGED_LOCAL,
    stop: async () => {
      await controller.stop({ force: true });
    },
    process: controller.process,
    getPublicUrl: () => publicUrl,
    getResolvedHostname: () => resolvedHost,
    getEffectiveConfigPath: () => effectiveConfigPath,
  };
}

export async function startCloudflareTunnel({ originUrl, port }) {
  void port;
  return startCloudflareQuickTunnel({ originUrl });
}

export function printTunnelWarning() {
  console.log(`
⚠️  Cloudflare Quick Tunnel Limitations:

   • Maximum 200 concurrent requests
   • Server-Sent Events (SSE) are NOT supported
   • URLs are temporary and will expire when the tunnel stops
   • Password protection is required for tunnel access

   For production use, set up a managed remote Cloudflare Tunnel:
   https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
`);
}
