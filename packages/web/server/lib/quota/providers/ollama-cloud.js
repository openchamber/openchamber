import { buildResult, toUsageWindow, toNumber } from '../utils/index.js';
import { readManagedCredential } from '../credentials/providers.js';

export const providerId = 'ollama-cloud';
export const providerName = 'Ollama Cloud';
const aliases = ['ollama-cloud', 'ollamacloud'];
const OLLAMA_CLOUD_ORIGIN = 'https://ollama.com';
const OLLAMA_SETTINGS_PATH = '/settings';
const OLLAMA_SIGNIN_PATH = '/signin';
const NO_USAGE_PAGE_PATTERN = /(?:^|>)\s*No usage(?: data)?(?: available)? yet\.?\s*(?=<|$)/i;

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

export const parseOllamaSettingsHtml = (html) => {
  const windows = {};
  const sessionMatch = html.match(/Session\s+usage(?:\s|<[^>]*>|[:：])*([0-9]+(?:\.[0-9]+)?)\s*%/i);
  if (sessionMatch) {
    windows.session = toUsageWindow({
      usedPercent: toNumber(sessionMatch[1]),
      windowSeconds: null,
      resetAt: null
    });
  }
  const weeklyMatch = html.match(/Weekly\s+usage(?:\s|<[^>]*>|[:：])*([0-9]+(?:\.[0-9]+)?)\s*%/i);
  if (weeklyMatch) {
    windows.weekly = toUsageWindow({
      usedPercent: toNumber(weeklyMatch[1]),
      windowSeconds: null,
      resetAt: null
    });
  }
  const premiumMatch = html.match(/Premium(?:\s|<[^>]*>|[:：])*([0-9]+)(?:\s|<[^>]*>)*\/(?:\s|<[^>]*>)*([0-9]+)/i);
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
  if (Object.keys(windows).length > 0 || NO_USAGE_PAGE_PATTERN.test(html)) return windows;
  throw new Error('Ollama Cloud usage response could not be parsed');
};

export const isConfigured = () => {
  return Boolean(readManagedCredential(providerId));
};

export const fetchOllamaCloudUsage = async (credential, fetchImpl = fetch) => {
  const response = await fetchImpl('https://ollama.com/settings', {
    method: 'GET',
    headers: { Cookie: credential.cookie, 'User-Agent': 'OpenChamber quota provider' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('Ollama Cloud authentication failed');
  }
  if (!response.ok) throw new Error(`Ollama Cloud returned HTTP ${response.status}`);
  assertOllamaCloudResponseUrl(response);
  const windows = parseOllamaSettingsHtml(await response.text());
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
