import {
  buildResult,
  toUsageWindow,
  toNumber,
} from '../utils/index.js';

export const providerId = 'opencode-go';
export const providerName = 'OpenCode';
export const aliases = ['opencode-go', 'opencode_go', 'opencodego'];

export const isConfigured = () => {
  return Boolean(
    process.env.OPENCODE_GO_WORKSPACE_ID && process.env.OPENCODE_GO_AUTH_COOKIE
  );
};

export const fetchQuota = async () => {
  const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID;
  const explicitCookie = process.env.OPENCODE_GO_AUTH_COOKIE;

  if (!workspaceId || !explicitCookie) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: !!workspaceId,
      error: !workspaceId ? 'Not configured' : 'No auth cookie found'
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const url = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Cookie: `auth=${explicitCookie}`,
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
