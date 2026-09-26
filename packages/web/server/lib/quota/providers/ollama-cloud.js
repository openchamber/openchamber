import { buildResult, toUsageWindow, toNumber } from '../utils/index.js';
import { readManagedCredential } from '../credentials/providers.js';

export const providerId = 'ollama-cloud';
export const providerName = 'Ollama Cloud';
const aliases = ['ollama-cloud', 'ollamacloud'];
const OLLAMA_CLOUD_ORIGIN = 'https://ollama.com';
const OLLAMA_SETTINGS_PATH = '/settings';
const OLLAMA_SIGNIN_PATH = '/signin';
const OLLAMA_REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const OLLAMA_MAX_REDIRECTS = 10;

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

export const isConfigured = () => {
  return Boolean(readManagedCredential(providerId));
};

const assertOllamaCloudResponseUrl = (response) => {
  let url;
  try {
    url = new URL(response.url);
  } catch {
    throw new Error('Ollama Cloud returned an invalid final URL');
  }

  if (url.origin !== OLLAMA_CLOUD_ORIGIN) {
    throw new Error('Ollama Cloud redirected to an unexpected origin');
  }
  if (url.pathname === OLLAMA_SIGNIN_PATH) {
    throw new Error('Ollama Cloud authentication failed');
  }
  if (url.pathname !== OLLAMA_SETTINGS_PATH) {
    throw new Error('Ollama Cloud returned an unexpected final path');
  }
};

const fetchOllamaCloudResponse = async (cookie, fetchImpl) => {
  let requestUrl = `${OLLAMA_CLOUD_ORIGIN}${OLLAMA_SETTINGS_PATH}`;
  let includeCookie = true;

  for (let redirectCount = 0; ; redirectCount += 1) {
    const headers = { 'User-Agent': 'OpenChamber quota provider' };
    if (includeCookie) headers.Cookie = cookie;
    const response = await fetchImpl(requestUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (!OLLAMA_REDIRECT_STATUS_CODES.has(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;
    if (redirectCount >= OLLAMA_MAX_REDIRECTS) throw new Error('Ollama Cloud returned too many redirects');

    let redirectUrl;
    try {
      redirectUrl = new URL(location, requestUrl);
    } catch {
      throw new Error('Ollama Cloud returned an invalid redirect URL');
    }
    if (redirectUrl.protocol !== 'http:' && redirectUrl.protocol !== 'https:') throw new Error('Ollama Cloud returned an invalid redirect URL');
    requestUrl = redirectUrl.href;
    includeCookie = redirectUrl.origin === OLLAMA_CLOUD_ORIGIN;
  }
};

export const fetchOllamaCloudUsage = async (credential, fetchImpl = fetch) => {
  const response = await fetchOllamaCloudResponse(credential.cookie, fetchImpl);
  if (response.status === 401 || response.status === 403) {
    throw new Error('Ollama Cloud authentication failed');
  }
  if (!response.ok) throw new Error(`Ollama Cloud returned HTTP ${response.status}`);
  assertOllamaCloudResponseUrl(response);
  const windows = parseOllamaSettingsHtml(await response.text());
  if (Object.keys(windows).length === 0) throw new Error('Ollama Cloud usage data could not be parsed');
  return windows;
};

export const fetchQuota = async () => {
  const credential = readManagedCredential(providerId);

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
    const windows = await fetchOllamaCloudUsage(credential);

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
