import { readAuthFile, writeAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  discoverBrowserCookie
} from '../utils/index.js';
import { isJsonMode, isQuietMode, canPrompt, printJson, log, text, isCancel } from '../../../../bin/cli-output.js';

export const providerId = 'opencode-go';
export const providerName = 'OpenCode';
export const aliases = ['opencode-go', 'opencode_go', 'opencodego'];

const hostPattern = /\.opencode\.ai$/;

const readEntry = () => {
  const envWorkspaceId = process.env.OPENCODE_GO_WORKSPACE_ID || null;
  const envCookie = process.env.OPENCODE_GO_AUTH_COOKIE || null;
  if (envWorkspaceId && envCookie) return { workspaceId: envWorkspaceId, cookie: envCookie };

  const auth = readAuthFile();
  return normalizeAuthEntry(getAuthEntry(auth, aliases));
};

export const isConfigured = () => {
  const entry = readEntry();
  return Boolean(entry?.workspaceId && entry?.cookie);
};

const resolveWorkspaceId = async (cookie) => {
  const response = await fetch('https://opencode.ai/auth', {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Cookie: `auth=${cookie}`,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) return null;
    const match = location.match(/\/workspace\/([^/]+)/);
    return match ? match[1] : null;
  }

  if (response.status === 200) {
    return null;
  }

  throw new Error(`Unexpected auth response: HTTP ${response.status}`);
};

export const login = async (options = {}) => {
  const auth = readAuthFile();
  if (Object.keys(auth).length === 0) {
    if (isJsonMode(options)) printJson({ provider: providerId, command: 'opencode auth login' });
    else if (isQuietMode(options)) process.stdout.write('Run: opencode auth login\n');
    else log.info(`Run 'opencode auth login' to add auth for ${providerName}.`);
    return;
  }

  if (isJsonMode(options)) {
    printJson({ provider: providerId, type: 'browser-login', loginUrl: 'https://opencode.ai/auth' });
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write('Login at https://opencode.ai/auth\n');
    return;
  }

  log.step('Open https://opencode.ai/auth in your browser and log in.');
  if (canPrompt(options)) {
    const result = await text({ message: 'Press Enter after logging in', placeholder: 'Enter to continue' });
    if (isCancel(result)) process.exit(0);
  }

  const cookie = await discoverBrowserCookie(hostPattern, 'auth');
  if (!cookie) {
    log.error('No cookie found. Run `openchamber quota login` again after logging in.');
    return;
  }

  let workspaceId;
  try {
    workspaceId = await resolveWorkspaceId(cookie);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to resolve workspace';
    log.error(msg);
    return;
  }

  if (!workspaceId) {
    log.error('No workspace found for this account.');
    return;
  }

  const stored = readAuthFile();
  const current = stored?.['opencode-go'] || {};
  writeAuthFile({ ...stored, 'opencode-go': { ...current, workspaceId, cookie } });

  log.success('Login complete.');
};

export const fetchQuota = async () => {
  const entry = readEntry();
  const workspaceId = entry?.workspaceId;
  const authCookie = entry?.cookie;

  if (!workspaceId || !authCookie) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: !!workspaceId && !!authCookie,
      error: !(workspaceId && authCookie) ? 'Not configured' : 'No auth cookie found'
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const url = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Cookie: `auth=${authCookie}`,
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: timeoutSignal,
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? 'Authentication failed' : `HTTP ${response.status}`
      });
    }

    const html = await response.text();
    const parsed = parseUsageHtml(html);
    const windows = {};

    if (parsed.rolling) {
      windows.rolling = toUsageWindow({
        usedPercent: toNumber(parsed.rolling.usagePercent),
        windowSeconds: parsed.rolling.resetInSec,
        resetAt: parsed.rolling.resetInSec ? Date.now() + parsed.rolling.resetInSec * 1000 : null,
      });
    }
    if (parsed.weekly) {
      windows.weekly = toUsageWindow({
        usedPercent: toNumber(parsed.weekly.usagePercent),
        windowSeconds: parsed.weekly.resetInSec,
        resetAt: parsed.weekly.resetInSec ? Date.now() + parsed.weekly.resetInSec * 1000 : null,
      });
    }
    if (parsed.monthly) {
      windows.monthly = toUsageWindow({
        usedPercent: toNumber(parsed.monthly.usagePercent),
        windowSeconds: parsed.monthly.resetInSec,
        resetAt: parsed.monthly.resetInSec ? Date.now() + parsed.monthly.resetInSec * 1000 : null,
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === 'AbortError' && timeoutSignal.aborted;
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : (error instanceof Error ? error.message : 'Request failed')
    });
  }
};

const parseUsageHtml = (html) => {
  const usage = { rolling: null, weekly: null, monthly: null };
  const patterns = {
    rolling: /rollingUsage:\$R\[\d+\]=(\{[^}]+\})/,
    weekly: /weeklyUsage:\$R\[\d+\]=(\{[^}]+\})/,
    monthly: /monthlyUsage:\$R\[\d+\]=(\{[^}]+\})/,
  };

  for (const [key, pattern] of Object.entries(patterns)) {
    const match = html.match(pattern);
    if (match) {
      try {
        const jsonStr = match[1].replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
        usage[key] = JSON.parse(jsonStr);
      } catch {
        continue;
      }
    }
  }

  return usage;
};
