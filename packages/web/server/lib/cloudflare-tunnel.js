import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { StringDecoder } from 'string_decoder';
import yaml from 'yaml';
import {
  createExecutableSearchEnv,
  resolveExecutableLaunchTarget,
} from './tunnels/executable-search.js';
import { createBoundedOutputAccumulator } from './shared/bounded-output-accumulator.js';
import { readBoundedFileSync } from './shared/bounded-file-read.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TRY_CF_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

// cloudflared writes its URL and ready/fatal log lines with no regard for
// pipe chunk boundaries, so output is matched over the shared bounded
// accumulator (lib/shared/bounded-output-accumulator.js, #1705), never
// per chunk.
const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
// spawnSync blocks the whole server event loop while it waits, so a hung
// cloudflared binary must be bounded: probe timeouts elsewhere in the tree
// use 5-10 s (package-manager), matching the ngrok availability checks.
const AVAILABILITY_CHECK_TIMEOUT_MS = 5000;
const MANAGED_TUNNEL_STARTUP_TIMEOUT_MS = 20000;
const MANAGED_TUNNEL_LIVENESS_FALLBACK_MS = 6000;
const TUNNEL_MODE_QUICK = 'quick';
const TUNNEL_MODE_MANAGED_REMOTE = 'managed-remote';
const TUNNEL_MODE_MANAGED_LOCAL = 'managed-local';

export async function checkCloudflaredAvailable({ timeoutMs = AVAILABILITY_CHECK_TIMEOUT_MS } = {}) {
  const target = resolveExecutableLaunchTarget('cloudflared');
  if (target) {
    try {
      const result = spawnSync(target.command, ['--version'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: target.env,
        timeout: timeoutMs,
      });
      if (result.status === 0) {
        return { available: true, path: target.command, version: result.stdout.trim() };
      }
    } catch {
      // Ignore
    }
  }
  return { available: false, path: null, version: null };
}

function printCloudflareTunnelInstallHelp() {
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

Or visit: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/
`);
}

const spawnCloudflared = (args, envOverrides = {}, resolvedBinaryPath = 'cloudflared') => spawn(resolvedBinaryPath, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: {
    ...createExecutableSearchEnv(),
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

// Exported for tests: the read is the seam the grown-after-stat and
// FIFO-swap regressions pin. The bounded sync reader opens the file once
// and judges it from the handle, so a file that grows past the cap after
// assertReadableFile's stat — or is swapped for a FIFO — is refused here
// instead of being read whole or blocking the server on the read.
export function extractHostnameFromCloudflaredConfigDetailed(configPath, contextLabel = 'Managed local tunnel config') {
  if (typeof configPath !== 'string' || configPath.trim().length === 0) {
    return { hostname: null, parseError: null };
  }

  let raw;
  try {
    const result = readBoundedFileSync(configPath, MANAGED_LOCAL_CONFIG_MAX_BYTES);
    if (!result.ok) {
      if (result.reason === 'too-large') {
        return {
          hostname: null,
          parseError: new Error(`${contextLabel} file is too large (max ${MANAGED_LOCAL_CONFIG_MAX_BYTES} bytes).`),
        };
      }
      if (result.reason === 'not-regular') {
        return {
          hostname: null,
          parseError: new Error(`${contextLabel} path is not a file. Select a cloudflared config file.`),
        };
      }
      return {
        hostname: null,
        parseError: new Error('Could not read the managed local tunnel config file. Check that the file exists and is accessible.'),
      };
    }
    raw = result.buffer.toString('utf8');
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

  const configHostnameResult = extractHostnameFromCloudflaredConfigDetailed(effectiveConfigPath, requestedPath ? 'Managed local tunnel config' : 'Managed local tunnel default config');
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

    const stdoutAccumulator = createBoundedOutputAccumulator();
    const stderrAccumulator = createBoundedOutputAccumulator();

    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(fallbackTimer);
      clearTimeout(hardTimeout);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.stdout?.off('end', onStdoutEnd);
      child.stderr?.off('end', onStderrEnd);
      child.off('exit', onExit);
      handler(value);
    };

    // A ready/fatal line can be split across pipe chunks; match only
    // complete lines reassembled by each stream's bounded accumulator.
    const inspectLines = (lines) => {
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        sawOutput = true;
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

    const inspectChunk = (accumulator, chunk) => {
      const { decoded, lines } = accumulator.push(chunk);
      if (decoded.trim().length > 0) {
        sawOutput = true;
      }
      inspectLines(lines);
    };

    // cloudflared's last log line can arrive with no trailing newline:
    // flushing releases it, so a fatal reason is not lost when the
    // stream ends or the child exits, and a ready line still settles.
    const inspectFlush = (accumulator) => {
      inspectLines(accumulator.flush());
    };

    const onStdout = (chunk) => {
      inspectChunk(stdoutAccumulator, chunk);
    };

    const onStderr = (chunk) => {
      inspectChunk(stderrAccumulator, chunk);
    };

    const onStdoutEnd = () => {
      inspectFlush(stdoutAccumulator);
    };

    const onStderrEnd = () => {
      inspectFlush(stderrAccumulator);
    };

    const onExit = (code) => {
      // 'exit' can fire before a stream emits 'end', so flush both held
      // final lines here; flush() clears them, so a later 'end' handler
      // cannot inspect one a second time.
      inspectFlush(stdoutAccumulator);
      if (settled) {
        return;
      }
      inspectFlush(stderrAccumulator);
      if (settled) {
        return;
      }
      finish(reject, new Error(`Cloudflared exited while starting ${modeLabel} (code ${code ?? 'unknown'})`));
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.stdout?.on('end', onStdoutEnd);
    child.stderr?.on('end', onStderrEnd);
    child.once('exit', onExit);

    const fallbackTimer = setTimeout(() => {
      // A fatal final line wins over the liveness fallback: flush and
      // inspect the held partial lines before treating any output as
      // proof the tunnel is alive.
      inspectFlush(stdoutAccumulator);
      if (settled) {
        return;
      }
      inspectFlush(stderrAccumulator);
      if (settled) {
        return;
      }
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

  const child = spawnCloudflared(['tunnel', '--url', originUrl], { HOME: tempDir }, cfCheck.path);

  let publicUrl = null;
  let tunnelReady = false;

  const stdoutAccumulator = createBoundedOutputAccumulator();
  const stderrAccumulator = createBoundedOutputAccumulator();

  const onData = (chunk, isStderr) => {
    // The trycloudflare URL can be split across pipe chunks; match it
    // against the bounded rolling buffer, not the single chunk.
    const { decoded, recentText } = (isStderr ? stderrAccumulator : stdoutAccumulator).push(chunk);

    if (!tunnelReady) {
      const match = recentText.match(TRY_CF_URL_REGEX);
      if (match) {
        publicUrl = match[0];
        tunnelReady = true;
      }
    }

    process.stderr.write(isStderr ? decoded : '');
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
        try { child.kill('SIGINT'); } catch { /* ignore */ }
        cleanupTempDir();
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

    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      clearInterval(checkReady);
      cleanupTempDir();
      // Any exit while startup is pending is a failed startup, even a
      // clean one after a URL was printed: the tunnel dies with the
      // process, so resolving would hand callers a controller for a
      // process that is already gone (Codex review, PR #1492).
      if (signal) {
        reject(new Error(`Cloudflared exited with signal ${signal}`));
      } else {
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

  const child = spawnCloudflared(['tunnel', 'run', '--token-file', effectiveTokenFilePath], {}, cfCheck.path);
  const publicUrl = `https://${normalizedHost}`;

  child.stdout.on('data', () => {
    // Keep stream drained, but avoid logging potentially sensitive output.
  });

  // Forward through a StringDecoder: a multi-byte character split
  // across pipe chunks must reach the log whole, not as U+FFFD
  // replacement characters from a per-chunk decode (#1734).
  const stderrDecoder = new StringDecoder('utf8');
  child.stderr.on('data', (chunk) => {
    process.stderr.write(stderrDecoder.write(chunk));
  });
  child.stderr.on('end', () => {
    process.stderr.write(stderrDecoder.end());
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

  try {
    await waitForManagedTunnelReady(child, { modeLabel: 'managed-remote tunnel' });
  } catch (error) {
    try { child.kill('SIGINT'); } catch { /* ignore */ }
    cleanupTempTokenFile();
    throw error;
  }

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

  const configHostnameResult = extractHostnameFromCloudflaredConfigDetailed(effectiveConfigPath, requestedPath ? 'Managed local tunnel config' : 'Managed local tunnel default config');
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

  const child = spawnCloudflared(args, {}, cfCheck.path);
  const publicUrl = `https://${resolvedHost}`;

  child.stdout.on('data', () => {
    // Keep stream drained, but avoid logging potentially sensitive output.
  });

  // Forward through a StringDecoder: a multi-byte character split
  // across pipe chunks must reach the log whole, not as U+FFFD
  // replacement characters from a per-chunk decode (#1734).
  const stderrDecoder = new StringDecoder('utf8');
  child.stderr.on('data', (chunk) => {
    process.stderr.write(stderrDecoder.write(chunk));
  });
  child.stderr.on('end', () => {
    process.stderr.write(stderrDecoder.end());
  });

  child.on('error', (error) => {
    console.error(`Cloudflared error: ${error.message}`);
  });

  try {
    await waitForManagedTunnelReady(child, { modeLabel: 'managed-local tunnel' });
  } catch (error) {
    try { child.kill('SIGINT'); } catch { /* ignore */ }
    throw error;
  }

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

async function startCloudflareTunnel({ originUrl, port }) {
  void port;
  return startCloudflareQuickTunnel({ originUrl });
}

export function printTunnelWarning() {
  console.log(`
⚠️  Quick Tunnel Limitations:

   • Provider limits may apply
   • URLs are temporary and will expire when the tunnel stops
   • Password protection is required for tunnel access

   For production use, set up a persistent provider tunnel or static domain.
`);
}
