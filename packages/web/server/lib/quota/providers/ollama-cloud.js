import {
  buildResult,
  toUsageWindow,
  toNumber,
  getAuthEntry,
  normalizeAuthEntry,
  asNonEmptyString
} from '../utils/index.js';
import { readManagedCredential } from '../credentials/providers.js';
import { readAuthFile } from '../../opencode/auth.js';

export const providerId = 'ollama-cloud';
export const providerName = 'Ollama Cloud';
export const aliases = ['ollama-cloud', 'ollamacloud'];

const OLLAMA_API_USAGE_URL = 'https://ollama.com/api/usage';
const AUTHENTICATION_ERROR = 'Ollama Cloud authentication failed';
const PARSE_ERROR = 'Ollama Cloud usage data could not be parsed';
const NO_USAGE_LIMITS_ERROR = 'Ollama Cloud usage API returned no usage limits for this plan';
const USAGE_WINDOW_KEYS = ['session', 'weekly'];

const getApiKey = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);
};

// toNumber('') and toNumber('  ') return 0, so a blank string would render a
// missing usage value as a real 0% window. Blank strings, booleans, and JSON
// containers are missing values, matching toNumber's non-number boundary.
const readUsageFraction = (limits, key) => {
  const value = limits?.[key]?.usage;
  if (value === null || value === undefined || value === true || value === false) return null;
  if (value instanceof Object) return null;
  if (String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const parseOllamaSettingsHtml = (html) => {
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
  // Cost-based plans render "Monthly usage" with a dollar amount instead of
  // session/weekly/premium windows; support both page shapes.
  const monthlyMatch = html.match(/Monthly\s+usage[\s\S]{0,200}?\$([0-9][0-9,.]*)\s+of\s+\$([0-9][0-9,.]*)/i);
  if (monthlyMatch) {
    const used = toNumber(monthlyMatch[1].replace(/,/g, ''));
    const total = toNumber(monthlyMatch[2].replace(/,/g, ''));
    const usedPercent = total && used !== null ? Math.min(100, (used / total) * 100) : null;
    windows.monthly = toUsageWindow({
      usedPercent,
      windowSeconds: null,
      resetAt: null,
      valueLabel: `$${monthlyMatch[1]} / $${monthlyMatch[2]}`
    });
  }
  // "Extra usage" credits block (visible when credits/auto-reload is enabled):
  // a balance, not a percent. Anchor on "Balance remaining" — nearby "Add $5"
  // and auto-reload copy also contain dollar amounts. Surfaced with the
  // credits_balance key and OpenAI-style plain money label (the UI renders
  // it as "Credits Balance"); a $0 balance is omitted rather than shown.
  const balanceMatch = html.match(/Balance\s+remaining[\s\S]{0,200}?\$([0-9][0-9,.]*)/i);
  if (balanceMatch) {
    const balance = toNumber(balanceMatch[1].replace(/,/g, ''));
    if (balance !== 0) {
      windows.credits_balance = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `$${balanceMatch[1]}`
      });
    }
  }
  return windows;
};

// GET https://ollama.com/api/usage is undocumented; limits[].usage is a 0..1
// fraction of the window that has been consumed. Only session/weekly fractions
// are used; activity and per-model breakdowns are ignored.
export const parseOllamaUsageJson = (payload) => {
  const limits = payload instanceof Object && !Array.isArray(payload) ? payload.limits : null;
  const windows = {};
  for (const key of USAGE_WINDOW_KEYS) {
    const usage = readUsageFraction(limits, key);
    if (usage === null) continue;
    windows[key] = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, usage * 100)),
      windowSeconds: null,
      resetAt: null
    });
  }
  return windows;
};

export const fetchOllamaApiUsage = async (apiKey, fetchImpl = fetch) => {
  const response = await fetchImpl(OLLAMA_API_USAGE_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'OpenChamber quota provider'
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    throw new Error(AUTHENTICATION_ERROR);
  }
  if (!response.ok) throw new Error(`Ollama Cloud usage API returned HTTP ${response.status}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(PARSE_ERROR);
  }
  if (!(payload instanceof Object) || Array.isArray(payload)) throw new Error(PARSE_ERROR);

  const windows = parseOllamaUsageJson(payload);
  if (Object.keys(windows).length === 0) throw new Error(NO_USAGE_LIMITS_ERROR);
  return windows;
};

export const isConfigured = () => {
  if (readManagedCredential(providerId)) return true;
  try {
    return Boolean(getApiKey(readAuthFile()));
  } catch {
    return false;
  }
};

export const fetchOllamaCloudUsage = async (credential, fetchImpl = fetch) => {
  const response = await fetchImpl('https://ollama.com/settings', {
    method: 'GET',
    headers: { Cookie: credential.cookie, 'User-Agent': 'OpenChamber quota provider' },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    throw new Error('Ollama Cloud authentication failed');
  }
  if (!response.ok) throw new Error(`Ollama Cloud returned HTTP ${response.status}`);
  const windows = parseOllamaSettingsHtml(await response.text());
  if (Object.keys(windows).length === 0) throw new Error('Ollama Cloud usage data could not be parsed');
  return windows;
};

export const fetchQuota = async ({
  readAuth = readAuthFile,
  readCredential = readManagedCredential,
  fetchImpl = fetch
} = {}) => {
  let apiKey = null;
  try {
    apiKey = getApiKey(readAuth());
  } catch {
    // An unreadable auth file means "no API key", not a request failure.
    apiKey = null;
  }

  // Strict source priority: an API key that exists is the only source used; a
  // failure here must not silently fall back to the cookie.
  if (apiKey) {
    try {
      const windows = await fetchOllamaApiUsage(apiKey, fetchImpl);

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
  }

  const credential = readCredential(providerId);

  if (!credential) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const windows = await fetchOllamaCloudUsage(credential, fetchImpl);

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
