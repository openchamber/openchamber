type OllamaWindow = { usedPercent: number | null; valueLabel?: string };
type OllamaFetch = (url: string, init: RequestInit) => Promise<Response>;

const OLLAMA_CLOUD_ORIGIN = 'https://ollama.com';
const OLLAMA_SETTINGS_PATH = '/settings';
const OLLAMA_SIGNIN_PATH = '/signin';
const OLLAMA_REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const OLLAMA_MAX_REDIRECTS = 10;

export const assertOllamaCloudResponseUrl = (response: { url: string }) => {
  let url: URL;
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

export const fetchOllamaCloudResponse = async (
  cookie: string,
  { fetchImpl = fetch, userAgent }: { fetchImpl?: OllamaFetch; userAgent?: string } = {},
): Promise<Response> => {
  let requestUrl = `${OLLAMA_CLOUD_ORIGIN}${OLLAMA_SETTINGS_PATH}`;
  let includeCookie = true;

  for (let redirectCount = 0; ; redirectCount += 1) {
    const headers: Record<string, string> = {};
    if (userAgent) headers['User-Agent'] = userAgent;
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

    let redirectUrl: URL;
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

export const fetchOllamaUsage = async (cookie: string, fetchImpl: OllamaFetch = fetch) => {
  const response = await fetchOllamaCloudResponse(cookie, {
    fetchImpl,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  });
  if (response.status === 401 || response.status === 403) throw new Error('Ollama Cloud authentication failed');
  if (!response.ok) throw new Error(`Ollama Cloud returned HTTP ${response.status}`);
  assertOllamaCloudResponseUrl(response);

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
