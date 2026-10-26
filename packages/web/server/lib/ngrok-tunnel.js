import { spawn, spawnSync } from 'child_process';
import {
  createExecutableSearchEnv,
  resolveExecutableLaunchTarget,
} from './tunnels/executable-search.js';
import { getTunnelDependencyInstallInfo } from './tunnels/install-help.js';
import { TUNNEL_PROVIDER_NGROK } from './tunnels/types.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const NGROK_API_URL = 'http://127.0.0.1:4040/api/tunnels';
const NGROK_PUBLIC_URL_REGEX = /https:\/\/[^\s"']+/i;
const NGROK_AUTHTOKEN_HELP = 'Run: ngrok config add-authtoken <your-ngrok-token>';
const getNgrokInstallInfo = () => getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_NGROK);

export async function checkNgrokAvailable() {
  const target = resolveExecutableLaunchTarget('ngrok');
  if (target) {
    try {
      const result = spawnSync(target.command, ['version'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: target.env,
      });
      if (result.status === 0) {
        return { available: true, path: target.command, version: result.stdout.trim() || result.stderr.trim() };
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

  const target = ngrokPath
    ? { command: ngrokPath, env: createExecutableSearchEnv() }
    : resolveExecutableLaunchTarget('ngrok');
  if (!target) {
    return { configured: false, detail: getNgrokInstallInfo().message };
  }

  try {
    const result = spawnSync(target.command, ['config', 'check'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: target.env,
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
  env: createExecutableSearchEnv(),
  killSignal: 'SIGINT',
});

const normalizeNgrokPublicUrl = (value) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' && parsed.hostname.includes('ngrok')) {
      return parsed.toString().replace(/\/$/, '');
    }
  } catch {
    return null;
  }
  return null;
};

export function extractNgrokPublicUrlFromText(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const parsedUrl = normalizeNgrokPublicUrl(parsed?.url) || normalizeNgrokPublicUrl(parsed?.public_url);
      if (parsedUrl) {
        return parsedUrl;
      }
    } catch {
      // ngrok may emit non-JSON diagnostics even when log-format=json.
    }

    const match = line.match(NGROK_PUBLIC_URL_REGEX);
    const matchedUrl = normalizeNgrokPublicUrl(match?.[0]);
    if (matchedUrl) {
      return matchedUrl;
    }
  }

  return null;
}

const normalizeNgrokDiagnosticText = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
};

export const summarizeNgrokOutput = (lines) => {
  const nonEmptyLines = Array.isArray(lines)
    ? lines.map((line) => String(line || '').trim()).filter(Boolean)
    : [];
  if (nonEmptyLines.length === 0) {
    return '';
  }

  for (const line of [...nonEmptyLines].reverse()) {
    try {
      const parsed = JSON.parse(line);
      const level = typeof parsed?.lvl === 'string' ? parsed.lvl.toLowerCase() : '';
      if (level !== 'eror' && level !== 'error' && level !== 'crit') {
        continue;
      }
      const err = normalizeNgrokDiagnosticText(parsed?.err);
      if (err && err !== '<nil>') {
        return err;
      }
    } catch {
      // Not a JSON ngrok log line.
    }
  }

  for (const line of [...nonEmptyLines].reverse()) {
    try {
      const parsed = JSON.parse(line);
      const err = normalizeNgrokDiagnosticText(parsed?.err);
      if (err && err !== '<nil>' && !/context canceled/i.test(err)) {
        return err;
      }
      const msg = normalizeNgrokDiagnosticText(parsed?.msg);
      if (msg && /failed|error|invalid|auth/i.test(msg)) {
        return msg;
      }
    } catch {
      // Not a JSON ngrok log line.
    }
  }

  const errorLines = nonEmptyLines
    .filter((line) => /^ERROR:/i.test(line))
    .map((line) => normalizeNgrokDiagnosticText(line.replace(/^ERROR:\s*/i, '')))
    .filter(Boolean);
  if (errorLines.length > 0) {
    return errorLines.slice(0, 4).join(' ');
  }

  const lastLine = [...nonEmptyLines].reverse().find((line) => line.trim().length > 0);
  if (!lastLine) {
    return '';
  }
  try {
    const parsed = JSON.parse(lastLine);
    if (typeof parsed?.err === 'string' && parsed.err.trim().length > 0) {
      return normalizeNgrokDiagnosticText(parsed.err);
    }
    if (typeof parsed?.msg === 'string' && parsed.msg.trim().length > 0) {
      return normalizeNgrokDiagnosticText(parsed.msg);
    }
  } catch {
    // Fall through to plain text output.
  }
  return normalizeNgrokDiagnosticText(lastLine);
};

const appendNgrokOutputSummary = (message, lines) => {
  const summary = summarizeNgrokOutput(lines);
  return summary ? `${message}: ${summary}` : message;
};

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
    const httpsTunnel = tunnels.find((entry) => entry?.proto === 'https' && normalizeNgrokPublicUrl(entry?.public_url));
    const fallbackTunnel = tunnels.find((entry) => normalizeNgrokPublicUrl(entry?.public_url));
    return normalizeNgrokPublicUrl(httpsTunnel?.public_url) || normalizeNgrokPublicUrl(fallbackTunnel?.public_url);
  } catch {
    return null;
  }
}

export async function startNgrokQuickTunnel({ port }) {
  const ngrokCheck = await checkNgrokAvailable();
  if (!ngrokCheck.available) {
    throw new Error(getNgrokInstallInfo().message);
  }

  const authtokenCheck = await checkNgrokAuthtokenConfigured(ngrokCheck.path);
  if (!authtokenCheck.configured) {
    throw new Error(`ngrok authtoken is not configured. ${authtokenCheck.detail || NGROK_AUTHTOKEN_HELP}`);
  }

  if (!Number.isFinite(port)) {
    throw new Error('A local port is required to start an ngrok tunnel');
  }

  const child = spawnNgrok(['http', '--log=stdout', '--log-format=json', `127.0.0.1:${port}`], ngrokCheck.path);
  let publicUrl = null;
  const recentOutput = [];

  const captureOutput = (chunk) => {
    const text = chunk.toString('utf8');
    const parsedUrl = extractNgrokPublicUrlFromText(text);
    if (parsedUrl) {
      publicUrl = parsedUrl;
    }

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      recentOutput.push(trimmed);
      if (recentOutput.length > 200) {
        recentOutput.shift();
      }
    }
    return text;
  };

  child.stdout.on('data', (chunk) => {
    captureOutput(chunk);
  });

  child.stderr.on('data', (chunk) => {
    const text = captureOutput(chunk);
    process.stderr.write(text);
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(checkReady);
      child.off('error', onError);
      child.off('exit', onExit);
      handler(value);
    };

    const timeout = setTimeout(() => {
      try { child.kill('SIGINT'); } catch { /* ignore */ }
      finish(reject, new Error(appendNgrokOutputSummary('Ngrok tunnel URL not received within 30 seconds', recentOutput)));
    }, DEFAULT_STARTUP_TIMEOUT_MS);

    const checkReady = setInterval(async () => {
      publicUrl = publicUrl || await fetchNgrokPublicUrl();
      if (publicUrl) {
        finish(resolve, null);
      }
    }, 250);

    const onError = (error) => {
      finish(reject, new Error(`Ngrok failed to start: ${error.message}`));
    };

    const onExit = (code) => {
      finish(reject, new Error(appendNgrokOutputSummary(`Ngrok exited while starting (code ${code ?? 'unknown'})`, recentOutput)));
    };

    child.once('error', onError);
    child.once('exit', onExit);
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
