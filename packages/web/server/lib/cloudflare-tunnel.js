import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TRY_CF_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

const DEFAULT_STARTUP_TIMEOUT_MS = 30000;

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
    mode: 'quick',
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

export async function startCloudflareNamedTunnel({ token, hostname }) {
  const cfCheck = await checkCloudflaredAvailable();

  if (!cfCheck.available) {
    printCloudflareTunnelInstallHelp();
    throw new Error('cloudflared is not installed');
  }

  const normalizedToken = typeof token === 'string' ? token.trim() : '';
  const normalizedHost = typeof hostname === 'string' ? hostname.trim().toLowerCase() : '';

  if (!normalizedToken) {
    throw new Error('Named tunnel token is required');
  }
  if (!normalizedHost) {
    throw new Error('Named tunnel hostname is required');
  }

  const child = spawnCloudflared(['tunnel', 'run', '--token', normalizedToken]);
  const publicUrl = `https://${normalizedHost}`;

  let exitedEarly = false;
  let earlyExitCode = null;

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

  await new Promise((resolve, reject) => {
    const readyTimer = setTimeout(() => {
      if (exitedEarly) {
        reject(new Error(`Cloudflared exited early with code ${earlyExitCode ?? 'unknown'}`));
      } else {
        resolve(null);
      }
    }, 2000);

    child.once('exit', (code) => {
      exitedEarly = true;
      earlyExitCode = code;
      clearTimeout(readyTimer);
      reject(new Error(`Cloudflared exited with code ${code ?? 'unknown'}`));
    });
  });

  return {
    mode: 'named',
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

   For production use, set up a named Cloudflare Tunnel:
   https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
`);
}
