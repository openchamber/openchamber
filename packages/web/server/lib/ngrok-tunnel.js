import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const NGROK_API_URL = 'http://127.0.0.1:4040/api/tunnels';
const NGROK_INSTALL_HELP = 'brew install ngrok';
const NGROK_AUTHTOKEN_HELP = 'Run: ngrok config add-authtoken <your-ngrok-token>';

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
        if (!stats.isFile()) {
          continue;
        }
        if (process.platform !== 'win32') {
          try {
            fs.accessSync(candidate, fs.constants.X_OK);
          } catch {
            continue;
          }
        }
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export async function checkNgrokAvailable() {
  const ngrokPath = await searchPathFor('ngrok');
  if (ngrokPath) {
    try {
      const result = spawnSync(ngrokPath, ['version'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      if (result.status === 0) {
        return { available: true, path: ngrokPath, version: result.stdout.trim() || result.stderr.trim() };
      }
    } catch {
      // Ignore and report unavailable below.
    }
  }
  return { available: false, path: null, version: null };
}

export async function checkNgrokAuthtokenConfigured(ngrokPath = null) {
  if (typeof process.env.NGROK_AUTHTOKEN === 'string' && process.env.NGROK_AUTHTOKEN.trim().length > 0) {
    return { configured: true, detail: 'NGROK_AUTHTOKEN is set.' };
  }

  const resolvedPath = ngrokPath || await searchPathFor('ngrok');
  if (!resolvedPath) {
    return { configured: false, detail: `ngrok is not installed. Install it with: ${NGROK_INSTALL_HELP}` };
  }

  try {
    const result = spawnSync(resolvedPath, ['config', 'check'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (result.status === 0) {
      return { configured: true, detail: output || 'ngrok config is valid.' };
    }
    return { configured: false, detail: output || NGROK_AUTHTOKEN_HELP };
  } catch (error) {
    return {
      configured: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkNgrokApiReachability({ fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (typeof fetchImpl !== 'function') {
    return { reachable: false, status: null, error: 'Fetch API is unavailable in this runtime.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('https://api.ngrok.com/', {
      method: 'GET',
      signal: controller.signal,
    });
    return { reachable: true, status: response.status, error: null };
  } catch (error) {
    return {
      reachable: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

const spawnNgrok = (args, resolvedBinaryPath = 'ngrok') => spawn(resolvedBinaryPath, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: process.env,
  killSignal: 'SIGINT',
});

async function fetchNgrokPublicUrl(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    return null;
  }
  try {
    const response = await fetchImpl(NGROK_API_URL, { method: 'GET' });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    const tunnels = Array.isArray(payload?.tunnels) ? payload.tunnels : [];
    const httpsTunnel = tunnels.find((entry) => entry?.proto === 'https' && typeof entry?.public_url === 'string');
    const fallbackTunnel = tunnels.find((entry) => typeof entry?.public_url === 'string');
    return httpsTunnel?.public_url || fallbackTunnel?.public_url || null;
  } catch {
    return null;
  }
}

export async function startNgrokQuickTunnel({ port }) {
  const ngrokCheck = await checkNgrokAvailable();
  if (!ngrokCheck.available) {
    throw new Error(`ngrok is not installed. Install it with: ${NGROK_INSTALL_HELP}`);
  }

  const authtokenCheck = await checkNgrokAuthtokenConfigured(ngrokCheck.path);
  if (!authtokenCheck.configured) {
    throw new Error(`ngrok authtoken is not configured. ${NGROK_AUTHTOKEN_HELP}`);
  }

  if (!Number.isFinite(port)) {
    throw new Error('A local port is required to start an ngrok tunnel');
  }

  const child = spawnNgrok(['http', String(port)], ngrokCheck.path);
  let publicUrl = null;

  child.stdout.on('data', () => {
    // Keep stream drained; ngrok exposes the URL via its local API.
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk.toString('utf8'));
  });

  child.on('error', (error) => {
    console.error(`Ngrok error: ${error.message}`);
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(checkReady);
      try { child.kill('SIGINT'); } catch { /* ignore */ }
      reject(new Error('Ngrok tunnel URL not received within 30 seconds'));
    }, DEFAULT_STARTUP_TIMEOUT_MS);

    const checkReady = setInterval(async () => {
      publicUrl = await fetchNgrokPublicUrl();
      if (publicUrl) {
        clearTimeout(timeout);
        clearInterval(checkReady);
        resolve(null);
      }
    }, 250);

    child.once('exit', (code) => {
      clearTimeout(timeout);
      clearInterval(checkReady);
      reject(new Error(`Ngrok exited while starting (code ${code ?? 'unknown'})`));
    });
  });

  return {
    mode: 'quick',
    stop: () => {
      try {
        child.kill('SIGINT');
      } catch {
        // Ignore.
      }
    },
    process: child,
    getPublicUrl: () => publicUrl,
  };
}
