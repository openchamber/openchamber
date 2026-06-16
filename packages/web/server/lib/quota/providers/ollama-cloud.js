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

export const providerId = 'ollama-cloud';
export const providerName = 'Ollama Cloud';
export const aliases = ['ollama-cloud', 'ollamacloud'];

const hostPattern = /\.ollama\.com$/;

const readEntry = () => {
  const envCookie = process.env.OLLAMA_CLOUD_COOKIE || null;
  if (envCookie) return { cookie: envCookie };

  const auth = readAuthFile();
  return normalizeAuthEntry(getAuthEntry(auth, aliases));
};

export const isConfigured = () => {
  const entry = readEntry();
  return Boolean(entry?.cookie);
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
    printJson({ provider: providerId, type: 'browser-login', loginUrl: 'https://ollama.com/settings' });
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write('Login at https://ollama.com/settings\n');
    return;
  }

  log.step('Open https://ollama.com/settings in your browser and log in.');
  if (canPrompt(options)) {
    const result = await text({ message: 'Press Enter after logging in', placeholder: 'Enter to continue' });
    if (isCancel(result)) process.exit(0);
  }

  const cookie = await discoverBrowserCookie(hostPattern, '__Secure-session');
  if (!cookie) {
    log.error('No cookie found. Run `openchamber quota login` again after logging in.');
    return;
  }

  const stored = readAuthFile();
  const current = stored?.[providerId] || {};
  writeAuthFile({ ...stored, [providerId]: { ...current, cookie } });

  log.success('Login complete.');
};

export const fetchQuota = async () => {
  const entry = readEntry();
  const authCookie = entry?.cookie;

  if (!authCookie) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetch('https://ollama.com/settings', {
      method: 'GET',
      headers: {
        Cookie: `__Secure-session=${authCookie}`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
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
    const windows = parseOllamaSettingsHtml(html);

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

const parseOllamaSettingsHtml = (html) => {
  const windows = {};
  const sessionMatch = html.match(/Session\s+usage[^0-9]*([0-9.]+)%/i);
  if (sessionMatch) {
    windows.session = toUsageWindow({
      usedPercent: toNumber(sessionMatch[1]),
      windowSeconds: null,
      resetAt: null
    });
  }
  const weeklyMatch = html.match(/Weekly\s+usage[^0-9]*([0-9.]+)%/i);
  if (weeklyMatch) {
    windows.weekly = toUsageWindow({
      usedPercent: toNumber(weeklyMatch[1]),
      windowSeconds: null,
      resetAt: null
    });
  }
  const premiumMatch = html.match(/Premium[^0-9]*([0-9]+)\s*\/\s*([0-9]+)/i);
  if (premiumMatch) {
    const used = toNumber(premiumMatch[1]);
    const total = toNumber(premiumMatch[2]);
    const usedPercent = total && used !== null ? Math.min(100, (used / total) * 100) : null;
    windows.premium = toUsageWindow({
      usedPercent,
      windowSeconds: null,
      resetAt: null,
      valueLabel: `${used ?? 0} / ${total ?? 0}`
    });
  }
  return windows;
};
