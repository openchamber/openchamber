type OpenCodeGoCredential = { workspaceId: string; authCookie: string };

const toWindow = (usedPercent: number, resetInSec: number) => ({
  usedPercent: Math.min(100, Math.max(0, usedPercent)),
  remainingPercent: 100 - Math.min(100, Math.max(0, usedPercent)),
  windowSeconds: null,
  resetAfterSeconds: Math.max(0, resetInSec),
  resetAt: Date.now() + Math.max(0, resetInSec) * 1000,
  resetAtFormatted: null,
  resetAfterFormatted: null,
});

export const fetchOpenCodeGoUsage = async (credential: OpenCodeGoCredential) => {
  const response = await fetch(`https://opencode.ai/workspace/${encodeURIComponent(credential.workspaceId)}/go`, { headers: { Accept: 'text/html', Cookie: `auth=${credential.authCookie}` }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) throw new Error('OpenCode Go authentication failed');
  if (!response.ok) throw new Error(`OpenCode Go dashboard returned HTTP ${response.status}`);
  const html = (await response.text()).replaceAll('&quot;', '"').replaceAll('&#34;', '"').replaceAll('\\u0022', '"').replaceAll('\\"', '"');
  const windows: Record<string, ReturnType<typeof toWindow>> = {};
  for (const [key, field] of Object.entries({ '5h': 'rollingUsage', weekly: 'weeklyUsage', monthly: 'monthlyUsage' })) {
    const body = html.match(new RegExp(`["']?${field}["']?\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{([^{}]*)\\}`, 's'))?.[1];
    if (!body) continue;
    const used = Number(body.match(/usagePercent\s*:\s*["']?(-?\d+(?:\.\d+)?)/)?.[1]);
    const reset = Number(body.match(/resetInSec\s*:\s*["']?(-?\d+(?:\.\d+)?)/)?.[1]);
    if (Number.isFinite(used) && Number.isFinite(reset)) windows[key] = toWindow(used, reset);
  }
  if (!Object.keys(windows).length) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};
