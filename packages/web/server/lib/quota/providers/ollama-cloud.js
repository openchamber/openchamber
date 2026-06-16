import { homedir } from 'os';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { readAuthFile } from '../../opencode/auth.js';
import { buildResult, toUsageWindow, toNumber, discoverBrowserCookie } from '../utils/index.js';
import { isJsonMode, isQuietMode, canPrompt, printJson, log, text, isCancel } from '../../../../bin/cli-output.js';

const COOKIE_PATH = join(homedir(), '.config', 'ollama-quota', 'cookie');
const hostPattern = /\.ollama\.com$/;

export const providerId = 'ollama-cloud';
export const providerName = 'Ollama Cloud';
export const aliases = ['ollama-cloud', 'ollamacloud'];

const readCookieFile = () => {
  try {
    if (!existsSync(COOKIE_PATH)) return null;
    const content = readFileSync(COOKIE_PATH, 'utf-8');
    const trimmed = content.trim();
    return trimmed || null;
  } catch {
    return null;
  }
};

const saveCookieFile = (cookie) => {
  try {
    mkdirSync(dirname(COOKIE_PATH), { recursive: true });
    writeFileSync(COOKIE_PATH, cookie, 'utf8');
  } catch {
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

const readCookie = () => {
  const envCookie = process.env.OLLAMA_CLOUD_COOKIE || null;
  if (envCookie) return envCookie;
  return readCookieFile();
};

export const isConfigured = () => {
  const cookie = readCookie();
  return Boolean(cookie);
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

  const cookie = await discoverBrowserCookie(hostPattern, 'ollama_session');
  if (cookie) {
    saveCookieFile(cookie);
    log.success('Cookie found and saved.');
  } else {
    log.error('No cookie found. Run `openchamber quota login` again after logging in.');
  }
};

export const fetchQuota = async () => {
  const authCookie = readCookie();

  if (!authCookie) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const response = await fetch('https://ollama.com/settings', {
      method: 'GET',
      headers: {
        Cookie: authCookie,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
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
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
