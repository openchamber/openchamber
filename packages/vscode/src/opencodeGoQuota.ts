type OpenCodeGoCredential = { apiKey: string };

const toWindow = (usedPercent: number, resetAt: string) => ({
  usedPercent: Math.min(100, Math.max(0, usedPercent)),
  remainingPercent: 100 - Math.min(100, Math.max(0, usedPercent)),
  windowSeconds: null,
  resetAfterSeconds: Math.max(0, Math.floor((new Date(resetAt).getTime() - Date.now()) / 1000)),
  resetAt: new Date(resetAt).getTime(),
  resetAtFormatted: null,
  resetAfterFormatted: null,
});

export const fetchOpenCodeGoUsage = async (credential: OpenCodeGoCredential) => {
  const response = await fetch('https://opencode.ai/zen/go/v1/usage', { headers: { Accept: 'application/json', Authorization: `Bearer ${credential.apiKey}` }, signal: AbortSignal.timeout(15_000) });
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) throw new Error('OpenCode Go authentication failed');
  if (!response.ok) throw new Error(`OpenCode Go usage API returned HTTP ${response.status}`);
  const payload = await response.json().catch(() => null) as { usage?: Record<string, { percent?: unknown; resetsAt?: unknown }> } | null;
  const windows: Record<string, ReturnType<typeof toWindow>> = {};
  for (const [key, apiKey] of Object.entries({ '5h': 'rolling', weekly: 'weekly', monthly: 'monthly' })) {
    const entry = payload?.usage?.[apiKey];
    if (typeof entry?.percent !== 'number' || !Number.isFinite(entry.percent) || typeof entry.resetsAt !== 'string' || !Number.isFinite(new Date(entry.resetsAt).getTime())) continue;
    windows[key] = toWindow(entry.percent, entry.resetsAt);
  }
  if (!Object.keys(windows).length) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};
