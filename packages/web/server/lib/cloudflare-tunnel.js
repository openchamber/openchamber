import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TRY_CF_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const MANAGED_TUNNEL_STARTUP_TIMEOUT_MS = 20000;
const MANAGED_TUNNEL_LIVENESS_FALLBACK_MS = 6000;
const TUNNEL_MODE_QUICK = 'quick';
const TUNNEL_MODE_MANAGED_REMOTE = 'managed-remote';
const TUNNEL_MODE_MANAGED_LOCAL = 'managed-local';

async function searchPathFor(command) {
  const pathValue = process.env.PATH || '';
  const segments = pathValue.split(path.delimiter).filter(Boolean);
  const WINDOWS_EXTENSIONS = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
        .split(';')
        .map((ext) => ext.trim().toLowerCase())
        .filter(Boolean)
        .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
    : [''];

  for (const dir of segments) {
    for (const ext of WINDOWS_EXTENSIONS) {
      const fileName = process.platform === 'win32' ? `${command}${ext}` : command;
      const candidate = path.join(dir, fileName);
      try {
        const stats = fs.statSync(candidate);
        if (stats.isFile()) {
          if (process.platform !== 'win32') {
            try {
              fs.accessSync(candidate, fs.constants.X_OK);
            } catch {
              continue;
            }
          }
          return candidate;
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

export async function checkCloudflaredAvailable() {
  const cfPath = await searchPathFor('cloudflared');
  if (cfPath) {
    try {
      const result = spawnSync(cfPath, ['--version'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      if (result.status === 0) {
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

const spawnCloudflared = (args, envOverrides = {}) => spawn('cloudflared', args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    CF_TELEMETRY_DISABLE: '1',
    ...envOverrides,
  },
  killSignal: 'SIGINT',
});

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

const FATAL_LOG_PATTERNS = [
  /error parsing.*config/i,
  /failed to .*config/i,
  /invalid token/i,
  /unauthorized/i,
  /credentials file .* not found/i,
  /provided tunnel credentials are invalid/i,
];

function isCloudflaredReadyLogLine(line) {
  if (!line) {
    return false;
  }
  return READY_LOG_PATTERNS.some((pattern) => pattern.test(line));
}

function isCloudflaredFatalLogLine(line) {
  if (!line) {
    return false;
  }
  return FATAL_LOG_PATTERNS.some((pattern) => pattern.test(line));
}

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

async function waitForManagedTunnelReady(child, { modeLabel }) {
  await new Promise((resolve, reject) => {
    let settled = false;
    let sawOutput = false;

    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(fallbackTimer);
      clearTimeout(hardTimeout);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      handler(value);
    };

    const inspectChunk = (chunk) => {
      const text = chunk.toString('utf8');
      if (text.trim().length > 0) {
        sawOutput = true;
      }
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        if (isCloudflaredReadyLogLine(line)) {
          finish(resolve, null);
          return;
        }
        if (isCloudflaredFatalLogLine(line)) {
          finish(reject, new Error(`Cloudflared failed to start ${modeLabel}: ${line}`));
          return;
        }
      }
    };

    const onStdout = (chunk) => {
      inspectChunk(chunk);
    };

    const onStderr = (chunk) => {
      inspectChunk(chunk);
    };

    const onExit = (code) => {
      finish(reject, new Error(`Cloudflared exited while starting ${modeLabel} (code ${code ?? 'unknown'})`));
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);

    const fallbackTimer = setTimeout(() => {
      if (sawOutput) {
        finish(resolve, null);
      }
    }, MANAGED_TUNNEL_LIVENESS_FALLBACK_MS);

    const hardTimeout = setTimeout(() => {
      finish(reject, new Error(`Timed out waiting for cloudflared to initialize ${modeLabel}. Check your tunnel config and credentials.`));
    }, MANAGED_TUNNEL_STARTUP_TIMEOUT_MS);
  });
}

export async function startCloudflareQuickTunnel({ originUrl }) {
  const cfCheck = await checkCloudflaredAvailable();

  if (!cfCheck.available) {
    printCloudflareTunnelInstallHelp();
    throw new Error('cloudflared is not installed');
  }

  console.log(`Using cloudflared: ${cfCheck.path} (${cfCheck.version})`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-cf-'));

  const child = spawnCloudflared(['tunnel', '--url', originUrl], { HOME: tempDir });

  let publicUrl = null;
  let tunnelReady = false;

  const onData = (chunk, isStderr) => {
    const text = chunk.toString('utf8');

    if (!tunnelReady) {
      const match = text.match(TRY_CF_URL_REGEX);
      if (match) {
        publicUrl = match[0];
        tunnelReady = true;
      }
    }

    process.stderr.write(isStderr ? text : '');
  };

  child.stdout.on('data', (chunk) => onData(chunk, false));
  child.stderr.on('data', (chunk) => onData(chunk, true));

  child.on('error', (error) => {
    console.error(`Cloudflared error: ${error.message}`);
    cleanupTempDir();
  });

  const cleanupTempDir = () => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  };

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!publicUrl) {
        reject(new Error('Tunnel URL not received within 30 seconds'));
      }
    }, DEFAULT_STARTUP_TIMEOUT_MS);

    const checkReady = setInterval(() => {
      if (publicUrl) {
        clearTimeout(timeout);
        clearInterval(checkReady);
        resolve(null);
      }
    }, 100);

    child.on('exit', (code) => {
      clearTimeout(timeout);
      clearInterval(checkReady);
      cleanupTempDir();
      if (code !== null && code !== 0) {
        reject(new Error(`Cloudflared exited with code ${code}`));
      }
    });
  });

  return {
    mode: TUNNEL_MODE_QUICK,
    stop: () => {
      try {
        child.kill('SIGINT');
      } catch {
        // Ignore
      }
    },
    process: child,
    getPublicUrl: () => publicUrl,
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

  const child = spawnCloudflared(['tunnel', 'run', '--token-file', effectiveTokenFilePath]);
  const publicUrl = `https://${normalizedHost}`;

  child.stdout.on('data', () => {
    // Keep stream drained, but avoid logging potentially sensitive output.
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    process.stderr.write(text);
  });

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

  child.on('error', (error) => {
    console.error(`Cloudflared error: ${error.message}`);
    cleanupTempTokenFile();
  });

  child.on('exit', () => {
    cleanupTempTokenFile();
  });

  await waitForManagedTunnelReady(child, { modeLabel: 'managed-remote tunnel' });

  return {
    mode: TUNNEL_MODE_MANAGED_REMOTE,
    stop: () => {
      try {
        child.kill('SIGINT');
      } catch {
        // Ignore
      }
      cleanupTempTokenFile();
    },
    process: child,
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

  const child = spawnCloudflared(args);
  const publicUrl = `https://${resolvedHost}`;

  child.stdout.on('data', () => {
    // Keep stream drained, but avoid logging potentially sensitive output.
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    process.stderr.write(text);
  });

  child.on('error', (error) => {
    console.error(`Cloudflared error: ${error.message}`);
  });

  await waitForManagedTunnelReady(child, { modeLabel: 'managed-local tunnel' });

  return {
    mode: TUNNEL_MODE_MANAGED_LOCAL,
    stop: () => {
      try {
        child.kill('SIGINT');
      } catch {
        // Ignore
      }
    },
    process: child,
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
