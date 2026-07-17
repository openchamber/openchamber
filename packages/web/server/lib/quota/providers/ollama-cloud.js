import { buildResult, toUsageWindow, toNumber } from '../utils/index.js';
import { readManagedCredential } from '../credentials/providers.js';

export const providerId = 'ollama-cloud';
export const providerName = 'Ollama Cloud';
const aliases = ['ollama-cloud', 'ollamacloud'];

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
  return windows;
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
  // With redirect: 'follow', an invalid cookie redirects to /signin (200 OK).
  // Detect this to avoid silently returning empty windows for bad credentials.
  if (response.url && response.url.includes('/signin')) {
    throw new Error('Ollama Cloud authentication failed');
  }
  // NOTE: empty windows ({}) is a valid state (configured cookie, no usage data).
  // If ollama.com changes its settings page markup, the parser may silently return {}
  // instead of throwing — the user sees zero usage rather than a parse error.
  // This tradeoff is intentional: a valid cookie + no usage is more common than
  // a silently broken parser, and the old empty-windows check blocked legitimate
  // credential saves when ollama.com returned 303 -> /signin.
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
