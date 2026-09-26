type OllamaWindow = { usedPercent: number | null; valueLabel?: string };
type OllamaFetch = (url: string, init: RequestInit) => Promise<Response>;

export const fetchOllamaUsage = async (cookie: string, fetchImpl: OllamaFetch = fetch) => {
  const response = await fetchImpl('https://ollama.com/settings', {
    method: 'GET',
    headers: {
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Ollama Cloud authentication failed');

  const html = await response.text();
  const windows: Record<string, OllamaWindow> = {};
  for (const [key, pattern] of [
    ['session', /Session\s+usage[^0-9]*([0-9.]+)%/i],
    ['weekly', /Weekly\s+usage[^0-9]*([0-9.]+)%/i],
  ] as const) {
    const match = html.match(pattern);
    if (!match) continue;
    const usedPercent = Number(match[1]);
    if (Number.isFinite(usedPercent)) {
      windows[key] = { usedPercent };
    }
  }

  const premium = html.match(/Premium[^0-9]*([0-9]+)\s*\/\s*([0-9]+)/i);
  if (premium) {
    const used = Number(premium[1]);
    const total = Number(premium[2]);
    if (Number.isFinite(used) && Number.isFinite(total)) {
      windows.premium = {
        usedPercent: total > 0 ? Math.min(100, (used / total) * 100) : null,
        valueLabel: `${used} / ${total}`,
      };
    }
  }

  const monthly = html.match(/Monthly\s+usage[\s\S]{0,200}?\$([0-9][0-9,.]*)\s+of\s+\$([0-9][0-9,.]*)/i);
  if (monthly) {
    const used = Number(monthly[1].replace(/,/g, ''));
    const total = Number(monthly[2].replace(/,/g, ''));
    if (Number.isFinite(used) && Number.isFinite(total)) {
      windows.monthly = {
        usedPercent: total > 0 ? Math.min(100, (used / total) * 100) : null,
        valueLabel: `$${monthly[1]} / $${monthly[2]}`,
      };
    }
  }

  // Anchor on the balance label, not nearby purchase or auto-reload amounts.
  const balanceMatch = html.match(/Balance\s+remaining[\s\S]{0,200}?\$([0-9][0-9,.]*)/i);
  if (balanceMatch) {
    const balance = Number(balanceMatch[1].replace(/,/g, ''));
    if (Number.isFinite(balance) && balance > 0) {
      windows.credits_balance = { usedPercent: null, valueLabel: `$${balanceMatch[1]}` };
    }
  }
  if (Object.keys(windows).length === 0) throw new Error('Ollama Cloud usage data could not be parsed');
  return windows;
};

// --- API-key usage path ---------------------------------------------------
// GET https://ollama.com/api/usage is undocumented; limits[].usage is a 0..1
// fraction of the window that has been consumed. This mirrors the web
// provider (packages/web/server/lib/quota/providers/ollama-cloud.js).

type OllamaUsageFraction = number | string | boolean | null | undefined;
type OllamaUsageFractionPayload = { usage?: OllamaUsageFraction };
type OllamaUsageLimitsPayload = {
  session?: OllamaUsageFractionPayload | null;
  weekly?: OllamaUsageFractionPayload | null;
};
type OllamaUsagePayload = { limits?: OllamaUsageLimitsPayload | null };
type OllamaUsageWindows = {
  session?: OllamaWindow;
  weekly?: OllamaWindow;
};

const OLLAMA_API_USAGE_URL = 'https://ollama.com/api/usage';
const OLLAMA_USAGE_WINDOW_KEYS = ['session', 'weekly'] as const;

const decodeOllamaUsagePayload = (value: OllamaUsagePayload | null): OllamaUsagePayload | null =>
  value instanceof Object && !Array.isArray(value) ? value : null;

// toNumber('') returns 0, so a blank string would render a missing usage value
// as a real 0% window. Blank strings, booleans, and JSON containers are
// missing values, matching the web parser's toNumber boundary.
const readOllamaUsageFraction = (value: OllamaUsageFraction): number | null => {
  if (value === null || value === undefined || value === true || value === false) return null;
  if (Array.isArray(value)) return null;
  if (String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const parseOllamaUsageJson = (payload: OllamaUsagePayload | null): OllamaUsageWindows => {
  const windows: OllamaUsageWindows = {};
  for (const key of OLLAMA_USAGE_WINDOW_KEYS) {
    const usage = readOllamaUsageFraction(payload?.limits?.[key]?.usage);
    if (usage === null) continue;
    windows[key] = { usedPercent: Math.min(100, Math.max(0, usage * 100)) };
  }
  return windows;
};

export const fetchOllamaUsageApi = async (apiKey: string, fetchImpl: OllamaFetch = fetch): Promise<Record<string, OllamaWindow>> => {
  const response = await fetchImpl(OLLAMA_API_USAGE_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'OpenChamber quota provider',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    throw new Error('Ollama Cloud authentication failed');
  }
  if (!response.ok) throw new Error(`Ollama Cloud usage API returned HTTP ${response.status}`);

  let raw: OllamaUsagePayload | null = null;
  try {
    raw = await response.text().then((text) => JSON.parse(text));
  } catch {
    throw new Error('Ollama Cloud usage data could not be parsed');
  }
  const payload = decodeOllamaUsagePayload(raw);
  if (!payload) throw new Error('Ollama Cloud usage data could not be parsed');

  const windows = parseOllamaUsageJson(payload);
  if (Object.keys(windows).length === 0) throw new Error('Ollama Cloud usage API returned no usage limits for this plan');
  return windows;
};
